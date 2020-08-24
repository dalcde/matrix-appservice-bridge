/*
Copyright 2020 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

const Datastore = require("nedb");
const Bluebird = require("bluebird");
const fs = require("fs");
const util = require("util");
const yaml = require("js-yaml");

const AppServiceRegistration = require("matrix-appservice").AppServiceRegistration;
const AppService = require("matrix-appservice").AppService;
const MatrixScheduler = require("matrix-js-sdk").MatrixScheduler;

const { BridgeContext } = require("./components/bridge-context");
const { ClientFactory } = require("./components/client-factory");
const { AppServiceBot } = require("./components/app-service-bot");
const RequestFactory = require("./components/request-factory").RequestFactory;
const Intent = require("./components/intent").Intent;
const RoomBridgeStore = require("./components/room-bridge-store");
const UserBridgeStore = require("./components/user-bridge-store");
const EventBridgeStore = require("./components/event-bridge-store");
const MatrixUser = require("./models/users/matrix").MatrixUser;
const MatrixRoom = require("./models/rooms/matrix").MatrixRoom;
const { PrometheusMetrics } = require("./components/prometheusmetrics");
const { MembershipCache } = require("./components/membership-cache");
const RoomLinkValidator = require("./components/room-link-validator").RoomLinkValidator;
const RLVStatus = require("./components/room-link-validator").validationStatuses;
const RoomUpgradeHandler = require("./components/room-upgrade-handler");
const { InternalError, EventNotHandledError, wrapError } = require("./errors").unstable;
const EventQueue = require("./components/event-queue").EventQueue;
const deferPromise = require("./utils/promiseutil").defer;

const log = require("./components/logging").get("bridge");

// The frequency at which we will check the list of accumulated Intent objects.
const INTENT_CULL_CHECK_PERIOD_MS = 1000 * 60; // once per minute
// How long a given Intent object can hang around unused for.
const INTENT_CULL_EVICT_AFTER_MS = 1000 * 60 * 15; // 15 minutes

/**
 * @constructor
 * @param {Object} opts Options to pass to the bridge
 * @param {AppServiceRegistration|string} opts.registration Application service
 * registration object or path to the registration file.
 * @param {string} opts.homeserverUrl The base HS url
 * @param {string} opts.domain The domain part for user_ids and room aliases
 * e.g. "bar" in "@foo:bar".
 * @param {string} opts.networkName A human readable string that will be used when
 * the bridge signals errors to the client. Will not include in error events if ommited.
 * @param {Object} opts.controller The controller logic for the bridge.
 * @param {Bridge~onEvent} opts.controller.onEvent Function. Called when
 * an event has been received from the HS.
 * @param {Bridge~onUserQuery=} opts.controller.onUserQuery Function. If supplied,
 * the bridge will invoke this function when queried via onUserQuery. If
 * not supplied, no users will be provisioned on user queries. Provisioned users
 * will automatically be stored in the associated <code>userStore</code>.
 * @param {Bridge~onAliasQuery=} opts.controller.onAliasQuery Function. If supplied,
 * the bridge will invoke this function when queried via onAliasQuery. If
 * not supplied, no rooms will be provisioned on alias queries. Provisioned rooms
 * will automatically be stored in the associated <code>roomStore</code>.
 * @param {Bridge~onAliasQueried=} opts.controller.onAliasQueried Function.
 * If supplied, the bridge will invoke this function when a room has been created
 * via onAliasQuery.
 * @param {Bridge~onLog=} opts.controller.onLog Function. Invoked when
 * logging. Defaults to a function which logs to the console.
 * @param {Bridge~thirdPartyLookup=} opts.controller.thirdPartyLookup Object. If
 * supplied, the bridge will respond to third-party entity lookups using the
 * contained helper functions.
 * @param {Bridge~onRoomUpgrade=} opts.controller.onRoomUpgrade Function. If
 * supplied, the bridge will invoke this function when it sees an upgrade event
 * for a room.
 * @param {(RoomBridgeStore|string)=} opts.roomStore The room store instance to
 * use, or the path to the room .db file to load. A database will be created if
 * this is not specified.
 * @param {(UserBridgeStore|string)=} opts.userStore The user store instance to
 * use, or the path to the user .db file to load. A database will be created if
 * this is not specified.
 * @param {(EventBridgeStore|string)=} opts.eventStore The event store instance to
 * use, or the path to the event .db file to load. This will NOT be created if it
 * isn't specified.
 * @param {MembershipCache=} opts.membershipCache The membership cache instance
 * to use, which can be manually created by a bridge for greater control over
 * caching. By default a membership cache will be created internally.
 * @param {boolean=} opts.suppressEcho True to stop receiving onEvent callbacks
 * for events which were sent by a bridge user. Default: true.
 * @param {ClientFactory=} opts.clientFactory The client factory instance to
 * use. If not supplied, one will be created.
 * @param {boolean} opts.logRequestOutcome True to enable SUCCESS/FAILED log lines
 * to be sent to onLog. Default: true.
 * @param {Object=} opts.intentOptions Options to supply to created Intent instances.
 * @param {Object=} opts.intentOptions.bot Options to supply to the bot intent.
 * @param {Object=} opts.intentOptions.clients Options to supply to the client intents.
 * @param {Object=} opts.escapeUserIds Escape userIds for non-bot intents with
 * {@link MatrixUser~escapeUserId}
 * Default: true
 * @param {Object=} opts.queue Options for the onEvent queue. When the bridge
 * receives an incoming transaction, it needs to asyncly query the data store for
 * contextual info before calling onEvent. A queue is used to keep the onEvent
 * calls consistent with the arrival order from the incoming transactions.
 * @param {string=} opts.queue.type The type of queue to use when feeding through
 * to {@link Bridge~onEvent}. One of: "none", single", "per_room". If "none",
 * events are fed through as soon as contextual info is obtained, which may result
 * in out of order events but stops HOL blocking. If "single", onEvent calls will
 * be in order but may be slower due to HOL blocking. If "per_room", a queue per
 * room ID is made which reduces the impact of HOL blocking to be scoped to a room.
 * Default: "single".
 * @param {boolean=} opts.queue.perRequest True to only feed through the next
 * event after the request object in the previous call succeeds or fails. It is
 * <b>vital</b> that you consistently resolve/reject the request if this is 'true',
 * else you will not get any further events from this queue. To aid debugging this,
 * consider setting a delayed listener on the request factory. If false, the mere
 * invockation of onEvent is enough to trigger the next event in the queue.
 * You probably want to set this to 'true' if your {@link Bridge~onEvent} is
 * performing async operations where ordering matters (e.g. messages). Default: false.
 * @param {boolean=} opts.disableContext True to disable {@link Bridge~BridgeContext}
 * parameters in {@link Bridge~onEvent}. Disabling the context makes the
 * bridge do fewer database lookups, but prevents there from being a
 * <code>context</code> parameter. Default: false.
 * @param {boolean=} opts.disableStores True to disable enabling of stores.
 * This should be used by bridges that use their own database instances and
 * do not need any of the included store objects. This implies setting
 * disableContext to True. Default: false.
 * @param {Object=} opts.roomLinkValidation Options to supply to the room link
 * validator. If not defined then all room links are accepted.
 * @param {string} opts.roomLinkValidation.ruleFile A file containing rules
 * on which matrix rooms can be bridged.
 * @param {Object=} opts.roomLinkValidation.rules A object containing rules
 * on which matrix rooms can be bridged. This is used if ruleFile is undefined.
 * @param {boolean=} opts.roomLinkValidation.triggerEndpoint Enable the endpoint
 * to trigger a reload of the rules file.
 * Default: false
 * @param {string} opts.authenticateThirdpartyEndpoints Should the bridge authenticate
 * requests to third party endpoints. This is false by default to be backwards-compatible
 * with Synapse.
 * @param {RoomUpgradeHandler~Options} opts.roomUpgradeOpts Options to supply to
 * the room upgrade handler. If not defined then upgrades are NOT handled by the bridge.
 */
function Bridge(opts) {
    if (typeof opts !== "object") {
        throw new Error("opts must be supplied.");
    }
    var required = [
        "homeserverUrl", "registration", "domain", "controller"
    ];
    required.forEach(function(key) {
        if (!opts[key]) {
            throw new Error("Missing '" + key + "' in opts.");
        }
    });
    if (typeof opts.controller.onEvent !== "function") {
        throw new Error("controller.onEvent is a required function");
    }


    if (opts.disableContext === undefined) {
        opts.disableContext = false;
    }

    if (opts.disableStores === true) {
        opts.disableStores = true;
        opts.disableContext = true;
    }
    else {
        opts.disableStores = false;
    }

    opts.authenticateThirdpartyEndpoints = opts.authenticateThirdpartyEndpoints || false;

    opts.userStore = opts.userStore || "user-store.db";
    opts.roomStore = opts.roomStore || "room-store.db";

    opts.eventStore = opts.eventStore || null; // Must be enabled
    opts.queue = opts.queue || {};
    opts.intentOptions = opts.intentOptions || {};
    opts.queue.type = opts.queue.type || "single";
    if (opts.queue.perRequest === undefined) {
        opts.queue.perRequest = false;
    }
    if (opts.logRequestOutcome === undefined) {
        opts.logRequestOutcome = true;
    }

    // Default: logger -> log to console
    opts.controller.onLog = opts.controller.onLog || function(text, isError) {
        if (isError) {
            log.error(text);
            return;
        }
        log.info(text);
    };

    // Default: suppress echo -> True
    if (opts.suppressEcho === undefined) {
        opts.suppressEcho = true;
    }

    // we'll init these at runtime
    this.appService = null;
    this.opts = opts;
    this._clientFactory = null;
    this._botClient = null;
    this._appServiceBot = null;
    this._requestFactory = null;
    this._botIntent = null;
    this._intents = {
        // user_id + request_id : Intent
    };
    this._intentLastAccessed = Object.create(null); // user_id + request_id : timestamp
    this._intentLastAccessedTimeout = null;
    this._powerLevelMap = {
        // room_id: event.content
    };
    this._membershipCache = opts.membershipCache || new MembershipCache();
    this._intentBackingStore = {
        setMembership: this._membershipCache.setMemberEntry.bind(this._membershipCache),
        setPowerLevelContent: this._setPowerLevelEntry.bind(this),
        getMembership: this._membershipCache.getMemberEntry.bind(this._membershipCache),
        getPowerLevelContent: this._getPowerLevelEntry.bind(this)
    };
    this._queue = EventQueue.create(this.opts.queue, this._onConsume.bind(this));
    this._prevRequestPromise = Bluebird.resolve();
    this._metrics = null; // an optional PrometheusMetrics instance
    this._roomLinkValidator = null;
    if (opts.roomUpgradeOpts) {
        opts.roomUpgradeOpts.consumeEvent = opts.roomUpgradeOpts.consumeEvent !== false ? true : false;
        if (this.opts.disableStores) {
            opts.roomUpgradeOpts.migrateStoreEntries = false;
        }
        this._roomUpgradeHandler = new RoomUpgradeHandler(opts.roomUpgradeOpts, this);
    }
    else {
        this._roomUpgradeHandler = null;
    }
}

/**
 * Load the user and room databases. Access them via getUserStore() and getRoomStore().
 * @return {Bluebird} Resolved/rejected when the user/room databases have been loaded.
 */
Bridge.prototype.loadDatabases = function() {
    if (this.opts.disableStores) {
        return Bluebird.resolve();
    }
    // Load up the databases if they provided file paths to them (or defaults)
    if (typeof this.opts.userStore === "string") {
        this.opts.userStore = loadDatabase(this.opts.userStore, UserBridgeStore);
    }
    if (typeof this.opts.roomStore === "string") {
        this.opts.roomStore = loadDatabase(this.opts.roomStore, RoomBridgeStore);
    }
    if (typeof this.opts.eventStore === "string") {
        this.opts.eventStore = loadDatabase(this.opts.eventStore, EventBridgeStore);
    }

    // This works because if they provided a string we converted it to a Promise
    // which will be resolved when we have the db instance. If they provided a
    // db instance then this will resolve immediately.
    return Bluebird.all([
        Bluebird.resolve(this.opts.userStore).then((db) => {
            this._userStore = db;
        }),
        Bluebird.resolve(this.opts.roomStore).then((db) => {
            this._roomStore = db;
        }),
        Bluebird.resolve(this.opts.eventStore).then((db) => {
            this._eventStore = db;
        })
    ]);
};

/**
 * Run the bridge (start listening)
 * @param {Number} port The port to listen on.
 * @param {Object} config Configuration options
 * @param {AppService=} appServiceInstance The AppService instance to attach to.
 * If not provided, one will be created.
 * @param {String} hostname Optional hostname to bind to. (e.g. 0.0.0.0)
 * @return {Bluebird} A promise resolving when the bridge is ready
 */
Bridge.prototype.run = function(port, config, appServiceInstance, hostname) {
    var self = this;

    // Load the registration file into an AppServiceRegistration object.
    if (typeof self.opts.registration === "string") {
        var regObj = yaml.safeLoad(fs.readFileSync(self.opts.registration, 'utf8'));
        self.opts.registration = AppServiceRegistration.fromObject(regObj);
        if (self.opts.registration === null) {
            throw new Error("Failed to parse registration file");
        }
    }

    this._clientFactory = self.opts.clientFactory || new ClientFactory({
        url: self.opts.homeserverUrl,
        token: self.opts.registration.getAppServiceToken(),
        appServiceUserId: `@${self.opts.registration.getSenderLocalpart()}:${self.opts.domain}`,
        clientSchedulerBuilder: function() {
            return new MatrixScheduler(retryAlgorithm, queueAlgorithm);
        },
    });
    this._clientFactory.setLogFunction(function(text, isErr) {
        if (!self.opts.controller.onLog) {
            return;
        }
        self.opts.controller.onLog(text, isErr);
    });
    this._botClient = this._clientFactory.getClientAs();
    this._appServiceBot = new AppServiceBot(
        this._botClient, self.opts.registration, this._membershipCache
    );

    if (this.opts.roomLinkValidation !== undefined) {
        this._roomLinkValidator = new RoomLinkValidator(
            this.opts.roomLinkValidation,
            this._appServiceBot
        );
    }

    this._requestFactory = new RequestFactory();
    if (this.opts.controller.onLog && this.opts.logRequestOutcome) {
        this._requestFactory.addDefaultResolveCallback(function(req, res) {
            self.opts.controller.onLog(
                "[" + req.getId() + "] SUCCESS (" + req.getDuration() + "ms)"
            );
        });
        this._requestFactory.addDefaultRejectCallback(function(req, err) {
            self.opts.controller.onLog(
                "[" + req.getId() + "] FAILED (" + req.getDuration() + "ms) " +
                (err ? util.inspect(err) : "")
            );
        });
    }
    var botIntentOpts = {
        registered: true,
        backingStore: this._intentBackingStore,
    };
    if (this.opts.intentOptions.bot) { // copy across opts
        Object.keys(this.opts.intentOptions.bot).forEach(function(k) {
            botIntentOpts[k] = self.opts.intentOptions.bot[k];
        });
    }
    this._botIntent = new Intent(this._botClient, this._botClient, botIntentOpts);
    this._intents = {
        // user_id + request_id : Intent
    };

    this.appService = appServiceInstance || new AppService({
        homeserverToken: this.opts.registration.getHomeserverToken()
    });
    this.appService.onUserQuery = (userId) => Bluebird.cast(this._onUserQuery(userId));
    this.appService.onAliasQuery = this._onAliasQuery.bind(this);
    this.appService.on("event", this._onEvent.bind(this));
    this.appService.on("http-log", function(line) {
        if (!self.opts.controller.onLog) {
            return;
        }
        self.opts.controller.onLog(line, false);
    });
    this._customiseAppservice();
    this._setupIntentCulling();

    if (this._metrics) {
        this._metrics.addAppServicePath(this);
    }

    // We MUST return a Bluebird-Promise instead of a Promise.
    // promise.done() is used by many tests in this repo.
    return this.loadDatabases().then(async() => {
        await this.appService.listen(port, hostname);
    });
};

/**
 * Apply any customisations required on the appService object.
 */
Bridge.prototype._customiseAppservice = function() {
    if (this.opts.controller.thirdPartyLookup) {
        this._customiseAppserviceThirdPartyLookup(this.opts.controller.thirdPartyLookup);
    }
    if (this.opts.roomLinkValidation && this.opts.roomLinkValidation.triggerEndpoint) {
        this.addAppServicePath({
            method: "POST",
            path: "/_bridge/roomLinkValidator/reload",
            handler: (req, res) => {
                try {
                    // Will use filename if provided, or the config
                    // one otherwised.
                    this._roomLinkValidator.readRuleFile(req.query.filename);
                    res.status(200).send("Success");
                }
                catch (e) {
                    res.status(500).send("Failed: " + e);
                }
            },
        });
    }
};

// Set a timer going which will periodically remove Intent objects to prevent
// them from accumulating too much. Removal is based on access time (calls to
// getIntent). Intents expire after INTENT_CULL_EVICT_AFTER_MS of not being called.
Bridge.prototype._setupIntentCulling = function() {
    if (this._intentLastAccessedTimeout) {
        clearTimeout(this._intentLastAccessedTimeout);
    }
    var self = this;
    this._intentLastAccessedTimeout = setTimeout(function() {
        var now = Date.now();
        Object.keys(self._intentLastAccessed).forEach(function(key) {
            if ((self._intentLastAccessed[key] + INTENT_CULL_EVICT_AFTER_MS) < now) {
                delete self._intentLastAccessed[key];
                delete self._intents[key];
            }
        });
        self._intentLastAccessedTimeout = null;
        // repeat forever. We have no cancellation mechanism but we don't expect
        // Bridge objects to be continually recycled so this is fine.
        self._setupIntentCulling();
    }, INTENT_CULL_CHECK_PERIOD_MS);
}

Bridge.prototype._customiseAppserviceThirdPartyLookup = function(lookupController) {
    var protocols = lookupController.protocols || [];

    var _respondErr = function(e, res) {
        if (typeof e === "object" && e.code && e.err) {
            res.status(e.code).json({error: e.err});
        }
        else {
            res.status(500).send("Failed: " + e);
        }
    }

    if (lookupController.getProtocol) {
        var getProtocolFunc = lookupController.getProtocol;

        this.addAppServicePath({
            method: "GET",
            path: "/_matrix/app/:version(v1|unstable)/thirdparty/protocol/:protocol",
            checkToken: this.opts.authenticateThirdpartyEndpoints,
            handler: function(req, res) {
                const protocol = req.params.protocol;

                if (protocols.length && protocols.indexOf(protocol) === -1) {
                    res.status(404).json({err: "Unknown 3PN protocol " + protocol});
                    return;
                }

                getProtocolFunc(protocol).then(
                    function(result) { res.status(200).json(result) },
                    function(e) { _respondErr(e, res) }
                );
            },
        });
    }

    if (lookupController.getLocation) {
        var getLocationFunc = lookupController.getLocation;

        this.addAppServicePath({
            method: "GET",
            path: "/_matrix/app/:version(v1|unstable)/thirdparty/location/:protocol",
            checkToken: this.opts.authenticateThirdpartyEndpoints,
            handler: function(req, res) {
                const protocol = req.params.protocol;

                if (protocols.length && protocols.indexOf(protocol) === -1) {
                    res.status(404).json({err: "Unknown 3PN protocol " + protocol});
                    return;
                }

                // Do not leak access token to function
                delete req.query.access_token;

                getLocationFunc(protocol, req.query).then(
                    function(result) { res.status(200).json(result) },
                    function(e) { _respondErr(e, res) }
                );
            },
        });
    }

    if (lookupController.parseLocation) {
        var parseLocationFunc = lookupController.parseLocation;

        this.addAppServicePath({
            method: "GET",
            path: "/_matrix/app/:version(v1|unstable)/thirdparty/location",
            checkToken: this.opts.authenticateThirdpartyEndpoints,
            handler: function(req, res) {
                const alias = req.query.alias;
                if (!alias) {
                    res.status(400).send({err: "Missing 'alias' parameter"});
                    return;
                }

                parseLocationFunc(alias).then(
                    function(result) { res.status(200).json(result) },
                    function(e) { _respondErr(e, res) }
                );
            },
        });
    }

    if (lookupController.getUser) {
        var getUserFunc = lookupController.getUser;

        this.addAppServicePath({
            method: "GET",
            path: "/_matrix/app/:version(v1|unstable)/thirdparty/user/:protocol",
            checkToken: this.opts.authenticateThirdpartyEndpoints,
            handler: function(req, res) {
                const protocol = req.params.protocol;

                if (protocols.length && protocols.indexOf(protocol) === -1) {
                    res.status(404).json({err: "Unknown 3PN protocol " + protocol});
                    return;
                }

                // Do not leak access token to function
                delete req.query.access_token;

                getUserFunc(protocol, req.query).then(
                    function(result) { res.status(200).json(result) },
                    function(e) { _respondErr(e, res) }
                );
            }
        });
    }

    if (lookupController.parseUser) {
        var parseUserFunc = lookupController.parseUser;

        this.addAppServicePath({
            method: "GET",
            path: "/_matrix/app/:version(v1|unstable)/thirdparty/user",
            checkToken: this.opts.authenticateThirdpartyEndpoints,
            handler: function(req, res) {
                const userid = req.query.userid;
                if (!userid) {
                    res.status(400).send({err: "Missing 'userid' parameter"});
                    return;
                }

                parseUserFunc(userid).then(
                    function(result) { res.status(200).json(result) },
                    function(e) { _respondErr(e, res) }
                );
            },
        });
    }
};

/**
 * Install a custom handler for an incoming HTTP API request. This allows
 * callers to add extra functionality, implement new APIs, etc...
 * @param {Object} opts Named options
 * @param {string} opts.method The HTTP method name.
 * @param {string} opts.path Path to the endpoint.
 * @param {string} opts.checkToken Should the token be automatically checked. Defaults to true.
 * @param {Bridge~appServicePathHandler} opts.handler Function to handle requests
 * to this endpoint.
 */
Bridge.prototype.addAppServicePath = function(opts) {
    // TODO(paul): This is gut-wrenching into the AppService instance itself.
    //   Maybe an API on that object would be good?
    const app = this.appService.app;
    opts.checkToken = opts.checkToken !== undefined ? opts.checkToken : true;

    // TODO(paul): Consider more options:
    //   opts.versions - automatic version filtering and rejecting of
    //     unrecognised API versions
    // Consider automatic "/_matrix/app/:version(v1|unstable)" path prefix
    app[opts.method.toLowerCase()](opts.path, (req, res, ...args) => {
        if (opts.checkToken && !this.requestCheckToken(req)) {
            return res.status(403).send({
                errcode: "M_FORBIDDEN",
                error: "Bad token supplied,"
            });
        }
        return opts.handler(req, res, ...args);
    });
};

/**
 * Retrieve the connected room store instance.
 * @return {?RoomBridgeStore} The connected instance ready for querying.
 */
Bridge.prototype.getRoomStore = function() {
    return this._roomStore;
};

/**
 * Retrieve the connected user store instance.
 * @return {?UserBridgeStore} The connected instance ready for querying.
 */
Bridge.prototype.getUserStore = function() {
    return this._userStore;
};

/**
 * Retrieve the connected event store instance, if one was configured.
 * @return {?EventBridgeStore} The connected instance ready for querying.
 */
Bridge.prototype.getEventStore = function() {
    return this._eventStore;
};

/**
 * Retrieve the request factory used to create incoming requests.
 * @return {RequestFactory}
 */
Bridge.prototype.getRequestFactory = function() {
    return this._requestFactory;
};

/**
 * Retrieve the matrix client factory used when sending matrix requests.
 * @return {ClientFactory}
 */
Bridge.prototype.getClientFactory = function() {
    return this._clientFactory;
};

/**
 * Get the AS bot instance.
 * @return {AppServiceBot}
 */
Bridge.prototype.getBot = function() {
    return this._appServiceBot;
};

/**
 * Determines whether a room should be provisoned based on
 * user provided rules and the room state. Will default to true
 * if no rules have been provided.
 * @param {string} roomId The room to check.
 * @param {boolean} cache Should the validator check it's cache.
 * @returns {Promise} resolves if can and rejects if it cannot.
 *                    A status code is returned on both.
 */
Bridge.prototype.canProvisionRoom = function(roomId, cache=true) {
    if (this._roomLinkValidator === null) {
        return Bluebird.resolve(RLVStatus.PASSED);
    }
    return this._roomLinkValidator.validateRoom(roomId, cache);
}

Bridge.prototype.getRoomLinkValidator = function() {
    return this._roomLinkValidator;
}

/**
 * Retrieve an Intent instance for the specified user ID. If no ID is given, an
 * instance for the bot itself is returned.
 * @param {?string} userId The user ID to get an Intent for.
 * @param {Request=} request Optional. The request instance to tie the MatrixClient
 * instance to. Useful for logging contextual request IDs.
 * @return {Intent} The intent instance
 */
Bridge.prototype.getIntent = function(userId, request) {
    if (!userId) {
        return this._botIntent;
    }
    if (this.opts.escapeUserIds === undefined || this.opts.escapeUserIds) {
        userId = new MatrixUser(userId).getId(); // Escape the ID
    }
    const key = userId + (request ? request.getId() : "");
    if (!this._intents[key]) {
        const client = this._clientFactory.getClientAs(userId, request);
        const clientIntentOpts = {
            backingStore: this._intentBackingStore
        };
        if (this.opts.intentOptions.clients) {
            Object.keys(this.opts.intentOptions.clients).forEach((k) => {
                clientIntentOpts[k] = this.opts.intentOptions.clients[k];
            });
        }
        clientIntentOpts.registered = this._membershipCache.isUserRegistered(userId);
        this._intents[key] = new Intent(client, this._botClient, clientIntentOpts);
    }
    this._intentLastAccessed[key] = Date.now();
    return this._intents[key];
};

/**
 * Retrieve an Intent instance for the specified user ID localpart. This <i>must
 * be the complete user localpart</i>.
 * @param {?string} localpart The user ID localpart to get an Intent for.
 * @param {Request=} request Optional. The request instance to tie the MatrixClient
 * instance to. Useful for logging contextual request IDs.
 * @return {Intent} The intent instance
 */
Bridge.prototype.getIntentFromLocalpart = function(localpart, request) {
    return this.getIntent(
        "@" + localpart + ":" + this.opts.domain
    );
};

/**
 * Provision a user on the homeserver.
 * @param {MatrixUser} matrixUser The virtual user to be provisioned.
 * @param {Bridge~ProvisionedUser} provisionedUser Provisioning information.
 * @return {Promise} Resolved when provisioned.
 */
Bridge.prototype.provisionUser = function (matrixUser, provisionedUser) {
    // For backwards compat
    return Bluebird.cast(this._provisionUser(matrixUser, provisionedUser));
};

Bridge.prototype._provisionUser = async function(matrixUser, provisionedUser) {
    await this._botClient.register(matrixUser.localpart);

    if (!this.opts.disableStores) {
        await this._userStore.setMatrixUser(matrixUser);
        if (provisionedUser.remote) {
            await this._userStore.linkUsers(matrixUser, provisionedUser.remote);
        }
    }
    const userClient = this._clientFactory.getClientAs(matrixUser.getId());
    if (provisionedUser.name) {
        await userClient.setDisplayName(provisionedUser.name);
    }
    if (provisionedUser.url) {
        await userClient.setAvatarUrl(provisionedUser.url);
    }
};

Bridge.prototype._onUserQuery = async function(userId) {
    if (!this.opts.controller.onUserQuery) {
        return;
    }
    const matrixUser = new MatrixUser(userId);
    try {
        const provisionedUser = await this.opts.controller.onUserQuery(matrixUser);
        if (!provisionedUser) {
            log.warn(`Not provisioning user for ${userId}`);
            return;
        }
        await this.provisionUser(matrixUser, provisionedUser);
    }
    catch (ex) {
        log.error(`Failed _onUserQuery for ${userId}`, ex);
    }
};

Bridge.prototype._onAliasQuery = function (alias) {
    // For backwards compat
    return Bluebird.cast(this.__onAliasQuery(alias));
};

Bridge.prototype.__onAliasQuery = async function(alias) {
    if (!this.opts.controller.onAliasQuery) {
        return;
    }
    const aliasLocalpart = alias.split(":")[0].substring(1);
    const provisionedRoom = await this.opts.controller.onAliasQuery(alias, aliasLocalpart);
    if (!provisionedRoom) {
        throw new Error("Not provisioning room for this alias");
    }
    const createRoomResponse = await this._botClient.createRoom(
        provisionedRoom.creationOpts
    );
    const roomId = createRoomResponse.room_id;
    if (!this.opts.disableStores) {
        const matrixRoom = new MatrixRoom(roomId);
        const remoteRoom = provisionedRoom.remote;
        if (remoteRoom) {
            await this._roomStore.linkRooms(matrixRoom, remoteRoom);
        }
        else {
            // store the matrix room only
            await this._roomStore.setMatrixRoom(matrixRoom);
        }
    }
    if (this.opts.controller.onAliasQueried) {
        await this.opts.controller.onAliasQueried(alias, roomId);
    }
}

Bridge.prototype._onEvent = function (event) {
    return Bluebird.cast(this.__onEvent(event));
};

// returns a Promise for the request linked to this event for testing.
Bridge.prototype.__onEvent = async function(event) {
    const isCanonicalState = event.state_key === "";
    this._updateIntents(event);
    if (this.opts.suppressEcho &&
            this.opts.registration.isUserMatch(event.sender, true)) {
        return null;
    }

    if (this._roomUpgradeHandler) {
        // m.room.tombstone is the event that signals a room upgrade.
        if (event.type === "m.room.tombstone" && isCanonicalState && this._roomUpgradeHandler) {
            this._roomUpgradeHandler.onTombstone(event);
            if (this.opts.roomUpgradeOpts.consumeEvent) {
                return null;
            }
        }
        else if (event.type === "m.room.member" &&
                event.state_key === this._appServiceBot.getUserId() &&
                event.content.membership === "invite") {
            // A invite-only room that has been upgraded won't have been joinable,
            // so we are listening for any invites to the new room.
            const isUpgradeInvite = await this._roomUpgradeHandler.onInvite(event);
            if (isUpgradeInvite &&
                this.opts.roomUpgradeOpts.consumeEvent) {
                return null;
            }
        }
    }

    const request = this._requestFactory.newRequest({ data: event });
    const contextReady = this._getBridgeContext(event);
    const dataReady = contextReady.then(context => ({ request, context }));

    const dataReadyLimited = this._limited(dataReady, request);

    this._queue.push(event, dataReadyLimited);
    this._queue.consume();
    const reqPromise = request.getPromise();

    // We *must* return the result of the request.
    return reqPromise.catch(
        EventNotHandledError,
        e => {
            this._handleEventError(event, e)
        }
    );
};

/**
 * Restricts the promise according to the bridges `perRequest` setting.
 *
 * `perRequest` enabled:
 *     Returns a promise similar to `promise`, with the addition of it only
 *     resolving after `request`.
 * `perRequest` disabled:
 *     Returns the promise unchanged.
 */
Bridge.prototype._limited = async function(promise, request) {
    // queue.perRequest controls whether multiple request can be processed by
    // the bridge at once.
    if (this.opts.queue.perRequest) {
        const promiseLimited = this._prevRequestPromise.reflect().return(promise);
        this._prevRequestPromise = request.getPromise();
        return promiseLimited;
    }

    return promise;
}

Bridge.prototype._onConsume = function(err, data) {
    if (err) {
        // The data for the event could not be retrieved.
        this.opts.controller.onLog("onEvent failure: " + err, true);
        return;
    }

    this.opts.controller.onEvent(data.request, data.context);
};

Bridge.prototype._getBridgeContext = async function(event) {
    if (this.opts.disableContext) {
        return null;
    }

    const context = new BridgeContext({
        sender: event.sender,
        target: event.type === "m.room.member" ? event.state_key : null,
        room: event.room_id
    });

    return context.get(this._roomStore, this._userStore);
}

Bridge.prototype._handleEventError = function(event, error) {
    if (!(error instanceof EventNotHandledError)) {
        error = wrapError(error, InternalError);
    }
    // TODO[V02460@gmail.com]: Send via different means when the bridge bot is
    // unavailable. _MSC2162: Signaling Errors at Bridges_ will have details on
    // how this should be done.
    this._botIntent.unstableSignalBridgeError(
        event.room_id,
        event.event_id,
        this.opts.networkName,
        error.reason,
        this._getUserRegex(),
    );
};

/**
 * Returns a regex matching all users of the bridge.
 *
 * @return {string} Super regex composed of all user regexes.
 */
Bridge.prototype._getUserRegex = function() {
    const reg = this.opts.registration;
    return reg.namespaces["users"].map(o => o.regex);
};

Bridge.prototype._updateIntents = function(event) {
    if (event.type === "m.room.member") {
        this._membershipCache.setMemberEntry(
            event.room_id,
            event.state_key,
            event.content ? event.content.membership : null
        );
    }
    else if (event.type === "m.room.power_levels") {
        this._setPowerLevelEntry(event.room_id, event.content);
    }
};

Bridge.prototype._setPowerLevelEntry = function(roomId, content) {
    this._powerLevelMap[roomId] = content;
};

Bridge.prototype._getPowerLevelEntry = function(roomId) {
    return this._powerLevelMap[roomId];
};

/**
 * Returns a PrometheusMetrics instance stored on the bridge, creating it first
 * if required. The instance will be registered with the HTTP server so it can
 * serve the "/metrics" page in the usual way.
 * The instance will automatically register the Matrix SDK metrics by calling
 * {PrometheusMetrics~registerMatrixSdkMetrics}.
 * @param {boolean} registerEndpoint Register the /metrics endpoint on the appservice HTTP server. Defaults to true.
 * @param {Registry?} registry Optionally provide an alternative registry for metrics.
 */
Bridge.prototype.getPrometheusMetrics = function(registerEndpoint = true, registry = undefined) {
    if (this._metrics) {
        return this._metrics;
    }

    const metrics = this._metrics = new PrometheusMetrics(registry);

    metrics.registerMatrixSdkMetrics();

    // TODO(paul): register some bridge-wide standard ones here

    // In case we're called after .run()
    if (this.appService && registerEndpoint) {
        metrics.addAppServicePath(this);
    }

    return metrics;
};

/**
 * A convenient shortcut to calling registerBridgeGauges() on the
 * PrometheusMetrics instance directly. This version will supply the value of
 * the matrixGhosts field if the counter function did not return it, for
 * convenience.
 * @param {PrometheusMetrics~BridgeGaugesCallback} counterFunc A function that
 * when invoked returns the current counts of various items in the bridge.
 *
 * @example
 * bridge.registerBridgeGauges(() => {
 *     return {
 *         matrixRoomConfigs: Object.keys(this.matrixRooms).length,
 *         remoteRoomConfigs: Object.keys(this.remoteRooms).length,
 *
 *         remoteGhosts: Object.keys(this.remoteGhosts).length,
 *
 *         ...
 *     }
 * })
 */
Bridge.prototype.registerBridgeGauges = function(counterFunc) {
    var self = this;

    this.getPrometheusMetrics().registerBridgeGauges(function() {
        var counts = counterFunc();

        if (!("matrixGhosts" in counts)) {
            counts.matrixGhosts = Object.keys(self._intents).length;
        }

        return counts;
    });
};

/**
 * Check a express Request to see if it's correctly
 * authenticated (includes the hsToken). The query parameter `access_token`
 * and the `Authorization` header are checked.
 * @returns {Boolean} True if authenticated, False if not.
 */
Bridge.prototype.requestCheckToken = function(req) {
    if (
        req.query.access_token !== this.opts.registration.getHomeserverToken() &&
        req.get("authorization") !== `Bearer ${this.opts.registration.getHomeserverToken()}`
    ) {
        return false;
    }
    return true;
}

function loadDatabase(path, Cls) {
    const defer = deferPromise();
    var db = new Datastore({
        filename: path,
        autoload: true,
        onload: function(err) {
            if (err) {
                defer.reject(err);
            }
            else {
                defer.resolve(new Cls(db));
            }
        }
    });
    return defer.promise;
}

function retryAlgorithm(event, attempts, err) {
    if (err.httpStatus === 400 || err.httpStatus === 403 || err.httpStatus === 401) {
        // client error; no amount of retrying with save you now.
        return -1;
    }
    // we ship with browser-request which returns { cors: rejected } when trying
    // with no connection, so if we match that, give up since they have no conn.
    if (err.cors === "rejected") {
        return -1;
    }

    if (err.name === "M_LIMIT_EXCEEDED") {
        var waitTime = err.data.retry_after_ms;
        if (waitTime) {
            return waitTime;
        }
    }
    if (attempts > 4) {
        return -1; // give up
    }
    return 1000 + (1000 * attempts);
}

function queueAlgorithm(event) {
    if (event.getType() === "m.room.message") {
        // use a separate queue for each room ID
        return "message_" + event.getRoomId();
    }
    // allow all other events continue concurrently.
    return null;
}


module.exports = Bridge;


/**
 * @typedef Bridge~ProvisionedUser
 * @type {Object}
 * @property {string=} name The display name to set for the provisioned user.
 * @property {string=} url The avatar URL to set for the provisioned user.
 * @property {RemoteUser=} remote The remote user to link to the provisioned user.
 */

/**
 * @typedef Bridge~ProvisionedRoom
 * @type {Object}
 * @property {Object} creationOpts Room creation options to use when creating the
 * room. Required.
 * @property {RemoteRoom=} remote The remote room to link to the provisioned room.
 */

/**
 * Invoked when the bridge receives a user query from the homeserver. Supports
 * both sync return values and async return values via promises.
 * @callback Bridge~onUserQuery
 * @param {MatrixUser} matrixUser The matrix user queried. Use <code>getId()</code>
 * to get the user ID.
 * @return {?Bridge~ProvisionedUser|Promise<Bridge~ProvisionedUser, Error>}
 * Reject the promise / return null to not provision the user. Resolve the
 * promise / return a {@link Bridge~ProvisionedUser} object to provision the user.
 * @example
 * new Bridge({
 *   controller: {
 *     onUserQuery: function(matrixUser) {
 *       var remoteUser = new RemoteUser("some_remote_id");
 *       return {
 *         name: matrixUser.localpart + " (Bridged)",
 *         url: "http://someurl.com/pic.jpg",
 *         user: remoteUser
 *       };
 *     }
 *   }
 * });
 */

/**
 * Invoked when the bridge receives an alias query from the homeserver. Supports
 * both sync return values and async return values via promises.
 * @callback Bridge~onAliasQuery
 * @param {string} alias The alias queried.
 * @param {string} aliasLocalpart The parsed localpart of the alias.
 * @return {?Bridge~ProvisionedRoom|Promise<Bridge~ProvisionedRoom, Error>}
 * Reject the promise / return null to not provision the room. Resolve the
 * promise / return a {@link Bridge~ProvisionedRoom} object to provision the room.
 * @example
 * new Bridge({
 *   controller: {
 *     onAliasQuery: function(alias, aliasLocalpart) {
 *       return {
 *         creationOpts: {
 *           room_alias_name: aliasLocalpart, // IMPORTANT: must be set to make the link
 *           name: aliasLocalpart,
 *           topic: "Auto-generated bridged room"
 *         }
 *       };
 *     }
 *   }
 * });
 */

 /**
  * Invoked when a response is returned from onAliasQuery. Supports
  * both sync return values and async return values via promises.
  * @callback Bridge~onAliasQueried
  * @param {string} alias The alias queried.
  * @param {string} roomId The parsed localpart of the alias.
  */


 /**
  * @callback Bridge~onRoomUpgrade
  * @param {string} oldRoomId The roomId of the old room.
  * @param {string} newRoomId The roomId of the new room.
  * @param {string} newVersion The new room version.
  * @param {Bridge~BridgeContext} context Context for the upgrade event.
  */

 /**
 * Invoked when the bridge receives an event from the homeserver.
 * @callback Bridge~onEvent
 * @param {Request} request The request to resolve or reject depending on the
 * outcome of this request. The 'data' attached to this Request is the raw event
 * JSON received (accessed via <code>request.getData()</code>)
 * @param {Bridge~BridgeContext} context Context for this event, including
 * instantiated client instances.
 */

 /**
 * Invoked when the bridge is attempting to log something.
 * @callback Bridge~onLog
 * @param {string} line The text to be logged.
 * @param {boolean} isError True if this line should be treated as an error msg.
 */

 /**
  * Handler function for custom applied HTTP API request paths. This is invoked
  * as defined by expressjs.
  * @callback Bridge~appServicePathHandler
  * @param {Request} req An expressjs Request object the handler can use to
  * inspect the incoming request.
  * @param {Response} res An expressjs Response object the handler can use to
  * send the outgoing response.
  */

 /**
  * @typedef Bridge~thirdPartyLookup
  * @type {Object}
  * @property {string[]} protocols Optional list of recognised protocol names.
  * If present, lookups for unrecognised protocols will be automatically
  * rejected.
  * @property {Bridge~getProtocol} getProtocol Function. Called for requests
  * for 3PE query metadata.
  * @property {Bridge~getLocation} getLocation Function. Called for requests
  * for 3PLs.
  * @property {Bridge~parseLocation} parseLocation Function. Called for reverse
  * parse requests on 3PL aliases.
  * @property {Bridge~getUser} getUser Function. Called for requests for 3PUs.
  * @property {Bridge~parseUser} parseUser Function. Called for reverse parse
  * requests on 3PU user IDs.
  */

 /**
  * Invoked on requests for 3PE query metadata
  * @callback Bridge~getProtocol
  * @param {string} protocol The name of the 3PE protocol to query
  * @return {Promise<Bridge~thirdPartyProtocolResult>} A Promise of metadata
  * about 3PE queries that can be made for this protocol.
  */

 /**
  * Returned by getProtocol third-party query metadata requests
  * @typedef Bridge~thirdPartyProtocolResult
  * @type {Object}
  * @property {string[]} [location_fields] Names of the fields required for
  * location lookups if location queries are supported.
  * @property {string[]} [user_fields] Names of the fields required for user
  * lookups if user queries are supported.

 /**
  * Invoked on requests for 3PLs
  * @callback Bridge~getLocation
  * @param {string} protocol The name of the 3PE protocol
  * @param {Object} fields The location query field data as specified by the
  * specific protocol.
  * @return {Promise<Bridge~thirdPartyLocationResult[]>} A Promise of a list of
  * 3PL lookup results.
  */

 /**
  * Invoked on requests to parse 3PL aliases
  * @callback Bridge~parseLocation
  * @param {string} alias The room alias to parse.
  * @return {Promise<Bridge~thirdPartyLocationResult[]>} A Promise of a list of
  * 3PL lookup results.
  */

 /**
  * Returned by getLocation and parseLocation third-party location lookups
  * @typedef Bridge~thirdPartyLocationResult
  * @type {Object}
  * @property {string} alias The Matrix room alias to the portal room
  * representing this 3PL
  * @property {string} protocol The name of the 3PE protocol
  * @property {object} fields The normalised values of the location query field
  * data.
  */

 /**
  * Invoked on requests for 3PUs
  * @callback Bridge~getUser
  * @param {string} protocol The name of the 3PE protocol
  * @param {Object} fields The user query field data as specified by the
  * specific protocol.
  * @return {Promise<Bridge~thirdPartyUserResult[]>} A Promise of a list of 3PU
  * lookup results.
  */

 /**
  * Invoked on requests to parse 3PU user IDs
  * @callback Bridge~parseUser
  * @param {string} userid The user ID to parse.
  * @return {Promise<Bridge~thirdPartyUserResult[]>} A Promise of a list of 3PU
  * lookup results.
  */

 /**
  * Returned by getUser and parseUser third-party user lookups
  * @typedef Bridge~thirdPartyUserResult
  * @type {Object}
  * @property {string} userid The Matrix user ID for the ghost representing
  * this 3PU
  * @property {string} protocol The name of the 3PE protocol
  * @property {object} fields The normalised values of the user query field
  * data.
  */
