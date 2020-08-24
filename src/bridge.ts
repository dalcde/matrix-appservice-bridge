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
import Datastore from "nedb";
import Bluebird from "bluebird";
import * as fs from "fs";
import * as util from "util";
import yaml from "js-yaml";
import { Application, Request as ExRequest, Response as ExResponse, NextFunction } from "express";

const MatrixScheduler = require("matrix-js-sdk").MatrixScheduler;

import { AppServiceRegistration, AppService } from "matrix-appservice";
import { BridgeContext } from "./components/bridge-context"
import { ClientFactory } from "./components/client-factory"
import { AppServiceBot } from "./components/app-service-bot"
import { RequestFactory } from "./components/request-factory";
import { Request } from "./components/request";
import { Intent, IntentOpts, IntentBackingStore, PowerLevelContent, RoomCreationOpts } from "./components/intent";
import { RoomBridgeStore } from "./components/room-bridge-store";
import { UserBridgeStore } from "./components/user-bridge-store";
import { EventBridgeStore } from "./components/event-bridge-store";
import { MatrixUser } from "./models/users/matrix"
import { MatrixRoom } from "./models/rooms/matrix"
import { PrometheusMetrics, BridgeGaugesCounts } from "./components/prometheusmetrics"
import { MembershipCache, UserMembership } from "./components/membership-cache"
import { RoomLinkValidator, RoomLinkValidatorStatus, Rules } from "./components/room-link-validator"
import { RoomUpgradeHandler, RoomUpgradeHandlerOpts } from "./components/room-upgrade-handler";
import { EventQueue } from "./components/event-queue";
import * as logging from "./components/logging";
import { defer as deferPromise } from "./utils/promiseutil";
import { unstable } from "./errors";
import { BridgeStore } from "./components/bridge-store";
import { RemoteUser } from "./models/users/remote";
import BridgeInternalError = unstable.BridgeInternalError;
import wrapError = unstable.wrapError;
import EventNotHandledError = unstable.EventNotHandledError;
import EventUnknownError = unstable.EventUnknownError;
import e = require("express");
import { ThirdpartyProtocolResponse, ThirdpartyLocationResponse, ThirdpartyUserResponse } from "./thirdparty";
import { RemoteRoom } from "./models/rooms/remote";

const log = logging.get("bridge");

// The frequency at which we will check the list of accumulated Intent objects.
const INTENT_CULL_CHECK_PERIOD_MS = 1000 * 60; // once per minute
// How long a given Intent object can hang around unused for.
const INTENT_CULL_EVICT_AFTER_MS = 1000 * 60 * 15; // 15 minutes

export interface WeakEvent extends Record<string, unknown> {
    event_id: string;
    room_id: string;
    sender: string;
    content: unknown;
    unsigned: {
        age: number;
    }
    origin_server_ts: number;
    state_key: string;
    type: string;
}

interface BridgeOpts {
    /**
     * Application service registration object or path to the registration file.
     */
    registration: AppServiceRegistration|string;
    /**
     * The base HS url
     */
    homeserverUrl: string;
    /**
     * The domain part for user_ids and room aliases e.g. "bar" in "@foo:bar".
     */
    domain: string;
    /**
     * A human readable string that will be used when the bridge signals errors
     * to the client. Will not include in error events if ommited.
     */
    networkName?: string;
    /**
     * The controller logic for the bridge.
     */
    controller: {
        /**
         * The bridge will invoke when an event has been received from the HS.
         */
        onEvent: (request: Request<WeakEvent>, context?: BridgeContext) => void;
        /**
         * The bridge will invoke this function when queried via onUserQuery. If
         * not supplied, no users will be provisioned on user queries. Provisioned users
         * will automatically be stored in the associated `userStore`.
         */
        onUserQuery?: (matrixUser: MatrixUser) => {name?: string, url?: string, remote?: RemoteUser}|void;
        /**
         * The bridge will invoke this function when queried via onAliasQuery. If
         * not supplied, no rooms will be provisioned on alias queries. Provisioned rooms
         * will automatically be stored in the associated `roomStore`. */
        onAliasQuery?: (alias: string, aliasLocalpart: string) => {creationOpts: Record<string, unknown>, remote?: RemoteRoom};
        /**
         * The bridge will invoke this function when a room has been created
         * via onAliasQuery.
         */
        onAliasQueried?: (alias: string, roomId: string) => void;
        /**
         * Invoked when logging. Defaults to a function which logs to the console.
         * */
        onLog?: (text: string, isError?: boolean) => void;
        /**
         * The bridge will invoke this function when it sees an upgrade event
         * for a room. If not supplied, no action will be performed on room upgrade.
         * */
        onRoomUpgrade?: () => void;
        /**
         * If supplied, the bridge will respond to third-party entity lookups using the
         * contained helper functions.
         */
        thirdPartyLookup?: {
            protocols: string[];
            getProtocol(protocol: string): ThirdpartyProtocolResponse|Promise<ThirdpartyProtocolResponse>;
            getLocation(protocol: string, fields: Record<string, string[]|string>):
                ThirdpartyLocationResponse[]|Promise<ThirdpartyLocationResponse[]>;
            parseLocation(alias: string): ThirdpartyLocationResponse[]|Promise<ThirdpartyLocationResponse[]>;
            getUser(protocol: string, fields: Record<string, string[]|string>):
             ThirdpartyUserResponse[]|Promise<ThirdpartyUserResponse[]>;
            parseUser(userid: string): ThirdpartyLocationResponse[]|Promise<ThirdpartyLocationResponse[]>;
        };
    };
    /**
     * True to disable enabling of stores.
     * This should be used by bridges that use their own database instances and
     * do not need any of the included store objects. This implies setting
     * disableContext to True. Default: false.
     */
    disableStores?: boolean;
    /**
     * The room store instance to use, or the path to the room .db file to load.
     * A database will be created if this is not specified. If `disableStores` is set,
     * no database will be created or used.
     */
    roomStore?: RoomBridgeStore|string;
    /**
     * The user store instance to use, or the path to the user .db file to load.
     * A database will be created if this is not specified. If `disableStores` is set,
     * no database will be created or used.
     */
    userStore?: UserBridgeStore|string;
    /**
     * The event store instance to use, or the path to the user .db file to load.
     * A database will NOT be created if this is not specified. If `disableStores` is set,
     * no database will be created or used.
     */
    eventStore?: EventBridgeStore|string;
    /**
     * The membership cache instance
     * to use, which can be manually created by a bridge for greater control over
     * caching. By default a membership cache will be created internally.
     */
    membershipCache?: MembershipCache;
    /**
     * True to stop receiving onEvent callbacks
     * for events which were sent by a bridge user. Default: true.
     */
    suppressEcho?: boolean;
    /**
     * The client factory instance to use. If not supplied, one will be created.
     */
    clientFactory?: ClientFactory;
    /**
     * True to enable SUCCESS/FAILED log lines to be sent to onLog. Default: true.
     */
    logRequestOutcome?: boolean;
    /**
     * Escape userIds for non-bot intents with
     * {@link MatrixUser~escapeUserId}
     * Default: true
     */
    escapeUserIds?: boolean;
    /**
     * Options to supply to created Intent instances.
     */
    intentOptions?: {
        /**
         * Options to supply to the bot intent.
         */
        bot?: IntentOpts;
        /**
         * Options to supply to the client intents.
         */
        clients?: IntentOpts;
    };
    /**
     * Options for the `onEvent` queue. When the bridge
     * receives an incoming transaction, it needs to asyncly query the data store for
     * contextual info before calling onEvent. A queue is used to keep the onEvent
     * calls consistent with the arrival order from the incoming transactions.
     */
    queue?: {
        /**
         * The type of queue to use when feeding through to {@link Bridge~onEvent}.
         * - If `none`, events are fed through as soon as contextual info is obtained, which may result
         * in out of order events but stops HOL blocking.
         * - If `single`, onEvent calls will be in order but may be slower due to HOL blocking.
         * - If `per_room`, a queue per room ID is made which reduces the impact of HOL blocking to be scoped to a room.
         *
         * Default: `single`.
         */
        type: "none"|"single"|"per_room";
        /**
         * `true` to only feed through the next event after the request object in the previous
         * call succeeds or fails. It is **vital** that you consistently resolve/reject the
         * request if this is 'true', else you will not get any further events from this queue.
         * To aid debugging this, consider setting a delayed listener on the request factory.
         *
         * If `false`, the mere invockation of onEvent is enough to trigger the next event in the queue.
         * You probably want to set this to `true` if your {@link Bridge~onEvent} is
         * performing async operations where ordering matters (e.g. messages).
         *
         * Default: false.
         * */
        perRequest: boolean;
    };
    /**
     * `true` to disable {@link BridgeContext}
     * parameters in {@link Bridge.onEvent}. Disabling the context makes the
     * bridge do fewer database lookups, but prevents there from being a
     * `context` parameter.
     *
     * Default: `false`.
     */
    disableContext: boolean;
    roomLinkValidation?: {
        ruleFile?: string;
        rules?: Rules;
        triggerEndpoint?: boolean;
    };
    authenticateThirdpartyEndpoints?: boolean;
    roomUpgradeOpts: RoomUpgradeHandlerOpts;
}

export class Bridge {
    private requestFactory: RequestFactory;
    private intents: Map<string, { intent: Intent, lastAccessed: number}>; // user_id + request_id => Intent
    private powerlevelMap: Map<string, PowerLevelContent>; // room_id => powerlevels
    private membershipCache: MembershipCache;
    private queue: EventQueue;
    private intentBackingStore: IntentBackingStore;
    private prevRequestPromise: Promise<unknown>;
    private readonly onLog: (message: string, isError?: boolean) => void;

    private intentLastAccessedTimeout: NodeJS.Timeout|null = null;
    private botIntent?: Intent;
    private appServiceBot?: AppServiceBot;
    private clientFactory?: ClientFactory;
    private botClient?: any;
    private metrics?: PrometheusMetrics;
    private roomLinkValidator?: RoomLinkValidator;
    private roomUpgradeHandler?: RoomUpgradeHandler;
    private roomStore?: RoomBridgeStore;
    private userStore?: UserBridgeStore;
    private eventStore?: EventBridgeStore;
    private registration?: AppServiceRegistration;
    private appservice?: AppService;

    public get appService() {
        return this.appservice;
    }

    /**
     * @param opts Options to pass to the bridge
     * @param {RoomUpgradeHandler~Options} opts.roomUpgradeOpts Options to supply to
     * the room upgrade handler. If not defined then upgrades are NOT handled by the bridge.
     */
    constructor (public readonly opts: BridgeOpts) {
        if (typeof opts !== "object") {
            throw new Error("opts must be supplied.");
        }
        const required = [
            "homeserverUrl", "registration", "domain", "controller"
        ];
        const missingKeys = required.filter(k => !Object.keys(opts).includes(k));
        if (missingKeys.length) {
            throw new Error(`Missing '${missingKeys.join("', '")}' in opts.`);
        }

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

        opts.intentOptions = opts.intentOptions || {};

        opts.queue = opts.queue || {
            type: "single",
            perRequest: false,
        };
        opts.queue.type = opts.queue.type || "single";
        if (opts.queue.perRequest === undefined) {
            opts.queue.perRequest = false;
        }
        if (opts.logRequestOutcome === undefined) {
            opts.logRequestOutcome = true;
        }
        this.queue = EventQueue.create(opts.queue, this.onConsume.bind(this));

        // Default: logger -> log to console
        this.onLog = opts.controller.onLog || function(text, isError) {
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
        this.opts = opts;
        this.requestFactory = new RequestFactory();
        this.intents = new Map();
        this.powerlevelMap = new Map();
        this.membershipCache = opts.membershipCache || new MembershipCache();
        this.intentBackingStore = {
            setMembership: this.membershipCache.setMemberEntry.bind(this.membershipCache),
            setPowerLevelContent: this.setPowerLevelEntry.bind(this),
            getMembership: this.membershipCache.getMemberEntry.bind(this.membershipCache),
            getPowerLevelContent: this.getPowerLevelEntry.bind(this)
        };

        this.prevRequestPromise = Promise.resolve();

        if (opts.roomUpgradeOpts) {
            opts.roomUpgradeOpts.consumeEvent = opts.roomUpgradeOpts.consumeEvent !== false ? true : false;
            if (this.opts.disableStores) {
                opts.roomUpgradeOpts.migrateStoreEntries = false;
            }
            this.roomUpgradeHandler = new RoomUpgradeHandler(opts.roomUpgradeOpts, this);
        }
    }

    /**
     * Load the user and room databases. Access them via getUserStore() and getRoomStore().
     */
    public async loadDatabases() {
        if (this.opts.disableStores) {
            return;
        }

        const storePromises: Promise<BridgeStore>[] = [];
        // Load up the databases if they provided file paths to them (or defaults)
        if (typeof this.opts.userStore === "string") {
            storePromises.push(loadDatabase(this.opts.userStore, UserBridgeStore));
        }
        else if (this.opts.userStore) {
            storePromises.push(Promise.resolve(this.opts.userStore));
        }
        if (typeof this.opts.roomStore === "string") {
            storePromises.push(loadDatabase(this.opts.roomStore, RoomBridgeStore));
        }
        else if (this.opts.roomStore) {
            storePromises.push(Promise.resolve(this.opts.roomStore));
        }
        if (typeof this.opts.eventStore === "string") {
            storePromises.push(loadDatabase(this.opts.eventStore, EventBridgeStore));
        }
        else if (this.opts.eventStore) {
            storePromises.push(Promise.resolve(this.opts.eventStore));
        }

        // This works because if they provided a string we converted it to a Promise
        // which will be resolved when we have the db instance. If they provided a
        // db instance then this will resolve immediately.
        const [userStore, roomStore, eventStore] = await Promise.all(storePromises);
        this.userStore = userStore as UserBridgeStore;
        this.roomStore = roomStore as RoomBridgeStore;
        this.eventStore = eventStore as EventBridgeStore;
    }

/**
 * Run the bridge (start listening)
 * @param port The port to listen on.
 * @param config Configuration options
 * @param appServiceInstance The AppService instance to attach to.
 * If not provided, one will be created.
 * @param hostname Optional hostname to bind to. (e.g. 0.0.0.0)
 * @return A promise resolving when the bridge is ready
 */
    public async run<T>(port: number, config: T, appServiceInstance?: AppService, hostname?: string, backlog = 10) {
        // Load the registration file into an AppServiceRegistration object.
        if (typeof this.opts.registration === "string") {
            const regObj = yaml.safeLoad(fs.readFileSync(this.opts.registration, 'utf8'));
            const registration = AppServiceRegistration.fromObject(regObj);
            if (registration === null) {
                throw Error("Failed to parse registration file");
            }
            this.registration = registration;
        }
        else if (this.opts.registration instanceof AppServiceRegistration) {
            this.registration = this.opts.registration;
        }
        else {
            throw Error('Invalid opts.registration provided');
        }

        const asToken = this.registration.getAppServiceToken();
        if (!asToken) {
            throw Error('No AS token provided, cannot create ClientFactory');
        }

        this.clientFactory = this.opts.clientFactory || new ClientFactory({
            url: this.opts.homeserverUrl,
            token: asToken,
            appServiceUserId: `@${this.registration.getSenderLocalpart()}:${this.opts.domain}`,
            clientSchedulerBuilder: function() {
                return new MatrixScheduler(retryAlgorithm, queueAlgorithm);
            },
        });
        this.clientFactory.setLogFunction((text, isErr) => {
            this.onLog(text, isErr);
        });
        this.botClient = this.clientFactory.getClientAs();
        this.appServiceBot = new AppServiceBot(
            this.botClient, this.registration, this.membershipCache,
        );

        if (this.opts.roomLinkValidation !== undefined) {
            this.roomLinkValidator = new RoomLinkValidator(
                this.opts.roomLinkValidation,
                this.appServiceBot,
            );
        }

        this.requestFactory = new RequestFactory();
        if (this.opts.logRequestOutcome) {
            this.requestFactory.addDefaultResolveCallback((req) =>
                this.onLog(
                    "[" + req.getId() + "] SUCCESS (" + req.getDuration() + "ms)"
                )
            );
            this.requestFactory.addDefaultRejectCallback((req, err) =>
                this.onLog(
                    "[" + req.getId() + "] FAILED (" + req.getDuration() + "ms) " +
                    (err ? util.inspect(err) : "")
                )
            );
        }
        const botIntentOpts: IntentOpts = {
            registered: true,
            backingStore: this.intentBackingStore,
            ...this.opts.intentOptions?.bot, // copy across opts, if defined
        };

        this.botIntent = new Intent(this.botClient, this.botClient, botIntentOpts);

        const homeserverToken = this.registration.getHomeserverToken();
        if (!homeserverToken) {
            throw Error('No HS token provided, cannot create AppService');
        }

        this.appservice = appServiceInstance || new AppService({
            homeserverToken,
        });
        this.appservice.onUserQuery = (userId) => this.onUserQuery(userId);
        this.appservice.onAliasQuery = this.onAliasQuery.bind(this);
        this.appservice.on("event", this.onEvent.bind(this));
        this.appservice.on("http-log", (line) => {
            this.onLog(line, false);
        });
        this.customiseAppservice();
        this.setupIntentCulling();

        if (this.metrics) {
            this.metrics.addAppServicePath(this);
        }

        await this.loadDatabases();
        await this.appservice.listen(port, hostname || "0.0.0.0", backlog);
    }

    /**
     * Apply any customisations required on the appService object.
     */
    private customiseAppservice() {
        this.customiseAppserviceThirdPartyLookup();
        if (this.opts.roomLinkValidation && this.opts.roomLinkValidation.triggerEndpoint) {
            this.addAppServicePath({
                method: "POST",
                path: "/_bridge/roomLinkValidator/reload",
                handler: (req, res) => {
                    try {
                        // Will use filename if provided, or the config
                        // one otherwised.
                        if (this.roomLinkValidator) {
                            this.roomLinkValidator?.readRuleFile(req.query.filename as string|undefined);
                            res.status(200).send("Success");
                        }
 else {
                            res.status(404).send("RoomLinkValidator not in use");
                        }
                    }
                    catch (e) {
                        res.status(500).send("Failed: " + e);
                    }
                },
            });
        }
    }

// Set a timer going which will periodically remove Intent objects to prevent
// them from accumulating too much. Removal is based on access time (calls to
// getIntent). Intents expire after `INTENT_CULL_EVICT_AFTER_MS` of not being called.
    private setupIntentCulling() {
        if (this.intentLastAccessedTimeout) {
            clearTimeout(this.intentLastAccessedTimeout);
        }
        this.intentLastAccessedTimeout = setTimeout(() => {
            const now = Date.now();
            for (const [key, entry] of this.intents.entries()) {
                if (entry.lastAccessed + INTENT_CULL_EVICT_AFTER_MS < now) {
                    this.intents.delete(key);
                }
            }
            this.intentLastAccessedTimeout = null;
            // repeat forever. We have no cancellation mechanism but we don't expect
            // Bridge objects to be continually recycled so this is fine.
            this.setupIntentCulling();
        }, INTENT_CULL_CHECK_PERIOD_MS);
    }

    private customiseAppserviceThirdPartyLookup() {
        const lookupController = this.opts.controller.thirdPartyLookup;
        if (!lookupController) {
            // Nothing to do.
            return;
        }
        const protocols = lookupController.protocols || [];

        const respondErr = function(e: {code?: number, err?: string}, res: ExResponse) {
            if (e.code && e.err) {
                res.status(e.code).json({error: e.err});
            }
            else {
                res.status(500).send("Failed: " + e);
            }
        }

        if (lookupController.getProtocol) {
            const getProtocolFunc = lookupController.getProtocol;

            this.addAppServicePath({
                method: "GET",
                path: "/_matrix/app/:version(v1|unstable)/thirdparty/protocol/:protocol",
                checkToken: this.opts.authenticateThirdpartyEndpoints,
                handler: async (req, res) => {
                    const protocol = req.params.protocol;

                    if (protocols.length && protocols.indexOf(protocol) === -1) {
                        res.status(404).json({err: "Unknown 3PN protocol " + protocol});
                        return;
                    }

                    try {
                        const result = await getProtocolFunc(protocol);
                        res.status(200).json(result);
                    }
 catch (ex) {
                        respondErr(ex, res)
                    }
                },
            });
        }

        if (lookupController.getLocation) {
            const getLocationFunc = lookupController.getLocation;

            this.addAppServicePath({
                method: "GET",
                path: "/_matrix/app/:version(v1|unstable)/thirdparty/location/:protocol",
                checkToken: this.opts.authenticateThirdpartyEndpoints,
                handler: async (req, res) => {
                    const protocol = req.params.protocol;

                    if (protocols.length && protocols.indexOf(protocol) === -1) {
                        res.status(404).json({err: "Unknown 3PN protocol " + protocol});
                        return;
                    }

                    // Do not leak access token to function
                    delete req.query.access_token;

                    try {
                        const result = await getLocationFunc(protocol, req.query as Record<string, string[]|string>);
                        res.status(200).json(result);
                    }
 catch (ex) {
                        respondErr(ex, res)
                    }
                },
            });
        }

        if (lookupController.parseLocation) {
            const parseLocationFunc = lookupController.parseLocation;

            this.addAppServicePath({
                method: "GET",
                path: "/_matrix/app/:version(v1|unstable)/thirdparty/location",
                checkToken: this.opts.authenticateThirdpartyEndpoints,
                handler: async (req, res) => {
                    const alias = req.query.alias;
                    if (!alias) {
                        res.status(400).send({err: "Missing 'alias' parameter"});
                        return;
                    }
                    if (typeof alias !== "string") {
                        res.status(400).send({err: "'alias' must be a string"});
                        return;
                    }

                    try {
                        const result = await parseLocationFunc(alias);
                        res.status(200).json(result);
                    }
 catch (ex) {
                        respondErr(ex, res)
                    }
                },
            });
        }

        if (lookupController.getUser) {
            const getUserFunc = lookupController.getUser;

            this.addAppServicePath({
                method: "GET",
                path: "/_matrix/app/:version(v1|unstable)/thirdparty/user/:protocol",
                checkToken: this.opts.authenticateThirdpartyEndpoints,
                handler: async (req, res) => {
                    const protocol = req.params.protocol;

                    if (protocols.length && protocols.indexOf(protocol) === -1) {
                        res.status(404).json({err: "Unknown 3PN protocol " + protocol});
                        return;
                    }

                    // Do not leak access token to function
                    delete req.query.access_token;

                    try {
                        const result = await getUserFunc(protocol, req.query as Record<string, string[]|string>);
                        res.status(200).json(result);
                    }
 catch (ex) {
                        respondErr(ex, res)
                    }
                }
            });
        }

        if (lookupController.parseUser) {
            const parseUserFunc = lookupController.parseUser;

            this.addAppServicePath({
                method: "GET",
                path: "/_matrix/app/:version(v1|unstable)/thirdparty/user",
                checkToken: this.opts.authenticateThirdpartyEndpoints,
                handler: async (req, res) => {
                    const userid = req.query.userid;
                    if (!userid) {
                        res.status(400).send({err: "Missing 'userid' parameter"});
                        return;
                    }
                    if (typeof userid !== "string") {
                        res.status(400).send({err: "'userid' must be a string"});
                        return;
                    }

                    try {
                        const result = await parseUserFunc(userid);
                        res.status(200).json(result);
                    }
 catch (ex) {
                        respondErr(ex, res)
                    }
                },
            });
        }
    }

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
    public addAppServicePath(opts: {method: "GET"|"PUT"|"POST"|"DELETE", checkToken?: boolean, path: string, handler: (req: ExRequest, respose: ExResponse, next: NextFunction) => void}) {
        // TODO(paul): This is gut-wrenching into the AppService instance itself.
        //   Maybe an API on that object would be good?
        const app: Application = (this.appservice as any).app;
        opts.checkToken = opts.checkToken !== undefined ? opts.checkToken : true;
        // TODO(paul): Consider more options:
        //   opts.versions - automatic version filtering and rejecting of
        //     unrecognised API versions
        // Consider automatic "/_matrix/app/:version(v1|unstable)" path prefix
        app[opts.method.toLowerCase() as "get"|"put"|"post"|"delete"](opts.path, (req, res, ...args) => {
            if (opts.checkToken && !this.requestCheckToken(req)) {
                return res.status(403).send({
                    errcode: "M_FORBIDDEN",
                    error: "Bad token supplied,"
                });
            }
            return opts.handler(req, res, ...args);
        });
    }

    /**
     * Retrieve the connected room store instance.
     */
    public getRoomStore() {
        return this.roomStore;
    }

    /**
     * Retrieve the connected user store instance.
     */
    public getUserStore() {
        return this.userStore;
    }

    /**
     * Retrieve the connected event store instance, if one was configured.
     */
    public getEventStore() {
        return this.eventStore;
    }

    /**
     * Retrieve the request factory used to create incoming requests.
     */
    public getRequestFactory() {
        return this.requestFactory;
    }

    /**
     * Retrieve the matrix client factory used when sending matrix requests.
     */
    public getClientFactory() {
        return this.clientFactory;
    }

    /**
     * Get the AS bot instance.
     */
    public getBot() {
        return this.appServiceBot;
    }

    /**
     * Determines whether a room should be provisoned based on
     * user provided rules and the room state. Will default to true
     * if no rules have been provided.
     * @param roomId The room to check.
     * @param cache Should the validator check it's cache.
     * @returns resolves if can and rejects if it cannot.
     *          A status code is returned on both.
     */
    public async canProvisionRoom(roomId: string, cache=true) {
        if (!this.roomLinkValidator) {
            return RoomLinkValidatorStatus.PASSED;
        }
        return this.roomLinkValidator.validateRoom(roomId, cache);
    }

    public getRoomLinkValidator() {
        return this.roomLinkValidator;
    }

    /**
     * Retrieve an Intent instance for the specified user ID. If no ID is given, an
     * instance for the bot itself is returned.
     * @param userId The user ID to get an Intent for.
     * @param request Optional. The request instance to tie the MatrixClient
     * instance to. Useful for logging contextual request IDs.
     * @return The intent instance
     */
    public getIntent(userId: string, request?: Request<unknown>) {
        if (!this.clientFactory) {
            throw Error('Cannot call getIntent before calling .run()');
        }
        if (!userId) {
            if (!this.botIntent) {
                // This will be defined when .run is called.
                throw Error('Cannot call getIntent before calling .run()');
            }
            return this.botIntent;
        }
        if (this.opts.escapeUserIds === undefined || this.opts.escapeUserIds) {
            userId = new MatrixUser(userId).getId(); // Escape the ID
        }

        const key = userId + (request ? request.getId() : "");
        const existingIntent = this.intents.get(key);
        if (existingIntent) {
            existingIntent.lastAccessed = Date.now();
            return existingIntent.intent;
        }

        const client = this.clientFactory.getClientAs(userId, request);
        const clientIntentOpts: IntentOpts = {
            backingStore: this.intentBackingStore,
            ...this.opts.intentOptions?.clients,
        };
        clientIntentOpts.registered = this.membershipCache.isUserRegistered(userId);
        const intent = new Intent(client, this.botClient, clientIntentOpts);
        this.intents.set(key, { intent, lastAccessed: Date.now() });

        return intent;
    }

    /**
     * Retrieve an Intent instance for the specified user ID localpart. This <i>must
     * be the complete user localpart</i>.
     * @param localpart The user ID localpart to get an Intent for.
     * @param request Optional. The request instance to tie the MatrixClient
     * instance to. Useful for logging contextual request IDs.
     * @return The intent instance
     */
    public getIntentFromLocalpart(localpart: string, request?: Request<unknown>) {
        return this.getIntent(
            "@" + localpart + ":" + this.opts.domain, request,
        );
    }


    /**
     * Provision a user on the homeserver.
     * @param matrixUser The virtual user to be provisioned.
     * @param provisionedUser Provisioning information.
     * @return Resolved when provisioned.
     */
    public async provisionUser(matrixUser: MatrixUser, provisionedUser?: {name?: string, url?: string, remote?: RemoteUser}) {
        if (!this.clientFactory) {
            throw Error('Cannot call getIntent before calling .run()');
        }
        await this.botClient.register(matrixUser.localpart);

        if (!this.opts.disableStores) {
            if (!this.userStore) {
                throw Error('Trued to call provisionUser before databases were loaded');
            }
            await this.userStore.setMatrixUser(matrixUser);
            if (provisionedUser?.remote) {
                await this.userStore.linkUsers(matrixUser, provisionedUser.remote);
            }
        }
        const userClient = this.clientFactory.getClientAs(matrixUser.getId());
        if (provisionedUser?.name) {
            await userClient.setDisplayName(provisionedUser.name);
        }
        if (provisionedUser?.url) {
            await userClient.setAvatarUrl(provisionedUser.url);
        }
    }

    private async onUserQuery(userId: string) {
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
    }

    private async onAliasQuery(alias: string) {
        if (!this.opts.controller.onAliasQuery) {
            return;
        }
        if (!this.opts.controller.onUserQuery) {
            return;
        }
        if (!this.botIntent) {
            throw Error('botIntent is not ready yet');
            return;
        }
        const aliasLocalpart = alias.split(":")[0].substring(1);
        const provisionedRoom = await this.opts.controller.onAliasQuery(alias, aliasLocalpart);
        const createRoomResponse: {room_id: string} = await this.botClient.createRoom(
            provisionedRoom.creationOpts
        );
        const roomId = createRoomResponse.room_id;
        if (!this.opts.disableStores) {
            if (!this.roomStore) {
                throw Error("roomStore is not ready yet");
            }
            const matrixRoom = new MatrixRoom(roomId);
            const remoteRoom = provisionedRoom.remote;
            if (remoteRoom) {
                await this.roomStore.linkRooms(matrixRoom, remoteRoom, {});
            }
            else {
                // store the matrix room only
                await this.roomStore.setMatrixRoom(matrixRoom);
            }
        }
        if (this.opts.controller.onAliasQueried) {
            await this.opts.controller.onAliasQueried(alias, roomId);
        }
    }

    // returns a Promise for the request linked to this event for testing.
    private async onEvent(event: WeakEvent) {
        if (!this.registration) {
            // Called before we were ready, which is probably impossible.
            return null;
        }
        const isCanonicalState = event.state_key === "";
        this.updateIntents(event);
        if (this.opts.suppressEcho &&
                this.registration.isUserMatch(event.sender, true)) {
            return null;
        }

        if (this.roomUpgradeHandler && this.appServiceBot) {
            // m.room.tombstone is the event that signals a room upgrade.
            if (event.type === "m.room.tombstone" && isCanonicalState && this.roomUpgradeHandler) {
                this.roomUpgradeHandler.onTombstone({...event, content: event.content as {replacement_room: string}});
                if (this.opts.roomUpgradeOpts.consumeEvent) {
                    return null;
                }
            }
            else if (event.type === "m.room.member" &&
                    event.state_key === this.appServiceBot.getUserId() &&
                    (event.content as {membership: UserMembership}).membership === "invite") {
                // A invite-only room that has been upgraded won't have been joinable,
                // so we are listening for any invites to the new room.
                const isUpgradeInvite = await this.roomUpgradeHandler.onInvite(event);
                if (isUpgradeInvite &&
                    this.opts.roomUpgradeOpts.consumeEvent) {
                    return null;
                }
            }
        }

        const request = this.requestFactory.newRequest({ data: event });
        const contextReady = this.getBridgeContext(event);
        const dataReady = contextReady.then(context => ({ request, context }));

        const dataReadyLimited = this.limited(dataReady, request);

        this.queue.push(event, dataReadyLimited);
        this.queue.consume();
        const reqPromise = request.getPromise();

        // We *must* return the result of the request.
        try {
            return await reqPromise;
        }
 catch (ex) {
            if (ex instanceof EventNotHandledError) {
                this.handleEventError(event, ex);
            }
        }
    }

    /**
     * Restricts the promise according to the bridges `perRequest` setting.
     *
     * `perRequest` enabled:
     *     Returns a promise similar to `promise`, with the addition of it only
     *     resolving after `request`.
     * `perRequest` disabled:
     *     Returns the promise unchanged.
     */
    private async limited<T>(promise: Promise<T>, request: Request<unknown>): Promise<T> {
        // queue.perRequest controls whether multiple request can be processed by
        // the bridge at once.
        if (this.opts.queue?.perRequest) {
            const promiseLimited = (async () => {
                try {
                    // We don't care about the results
                    await this.prevRequestPromise;
                }
 finally {
                    return promise;
                }
            })();
            this.prevRequestPromise = promiseLimited;
            return promiseLimited;
        }

        return promise;
    }

    private onConsume(err: Error|null, data: { request: Request<WeakEvent>, context?: BridgeContext}) {
        if (err) {
            // The data for the event could not be retrieved.
            this.onLog("onEvent failure: " + err, true);
            return;
        }

        this.opts.controller.onEvent(data.request, data.context);
    }

    private async getBridgeContext(event: {sender: string, type: string, state_key: string, room_id: string}) {
        if (this.opts.disableContext) {
            return null;
        }

        if (!this.roomStore || !this.userStore) {
            throw Error('Cannot call getBridgeContext before loading databases');
        }

        const context = new BridgeContext({
            sender: event.sender,
            target: event.type === "m.room.member" ? event.state_key : undefined,
            room: event.room_id
        });

        return context.get(this.roomStore, this.userStore);
    }

    private handleEventError(event: {room_id: string, event_id: string}, error: EventNotHandledError) {
        if (!this.botIntent) {
            throw Error('Cannot call handleEventError before calling .run()');
        }
        if (!(error instanceof EventNotHandledError)) {
            error = wrapError(error, BridgeInternalError);
        }
        // TODO[V02460@gmail.com]: Send via different means when the bridge bot is
        // unavailable. _MSC2162: Signaling Errors at Bridges_ will have details on
        // how this should be done.
        this.botIntent.unstableSignalBridgeError(
            event.room_id,
            event.event_id,
            this.opts.networkName,
            error.reason,
            this.getUserRegex(),
        );
    }

    /**
     * Returns a regex matching all users of the bridge.
     * @return Super regex composed of all user regexes.
     */
    private getUserRegex(): string[] {
        // Return empty array if registration isn't available yet.
        return this.registration?.getOutput().namespaces.users.map(o => o.regex) || [];
    }

    private updateIntents(event: WeakEvent) {
        if (event.type === "m.room.member") {
            const content = event.content as { membership: UserMembership };
            this.membershipCache.setMemberEntry(
                event.room_id,
                event.state_key,
                content ? content.membership : null
            );
        }
        else if (event.type === "m.room.power_levels") {
            const content = event.content as PowerLevelContent;
            this.setPowerLevelEntry(event.room_id, content);
        }
    }

    private setPowerLevelEntry(roomId: string, content: PowerLevelContent) {
        this.powerlevelMap.set(roomId, content);
    }

    private getPowerLevelEntry(roomId: string) {
        return this.powerlevelMap.get(roomId);
    }

    /**
     * Returns a PrometheusMetrics instance stored on the bridge, creating it first
     * if required. The instance will be registered with the HTTP server so it can
     * serve the "/metrics" page in the usual way.
     * The instance will automatically register the Matrix SDK metrics by calling
     * {PrometheusMetrics~registerMatrixSdkMetrics}.
     * @param {boolean} registerEndpoint Register the /metrics endpoint on the appservice HTTP server. Defaults to true.
     * @param {Registry?} registry Optionally provide an alternative registry for metrics.
     */
    public getPrometheusMetrics(registerEndpoint = true, registry = undefined): PrometheusMetrics {
        if (this.metrics) {
            return this.metrics;
        }

        const metrics = this.metrics = new PrometheusMetrics(registry);

        metrics.registerMatrixSdkMetrics();

        // TODO(paul): register some bridge-wide standard ones here

        // In case we're called after .run()
        if (this.appService && registerEndpoint) {
            metrics.addAppServicePath(this);
        }

        return metrics;
    }

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
    public registerBridgeGauges(counterFunc: () => BridgeGaugesCounts) {
        this.getPrometheusMetrics().registerBridgeGauges(() => {
            const counts = counterFunc();
            if (counts.matrixGhosts !== undefined) {
                counts.matrixGhosts = Object.keys(this.intents.size).length;
            }
            return counts;
        });
    }

    /**
     * Check a express Request to see if it's correctly
     * authenticated (includes the hsToken). The query parameter `access_token`
     * and the `Authorization` header are checked.
     * @returns {Boolean} True if authenticated, False if not.
     */
    public requestCheckToken(req: ExRequest) {
        if (!this.registration) {
            // Bridge isn't ready yet
            return false;
        }
        if (
            req.query.access_token !== this.registration.getHomeserverToken() &&
            req.get("authorization") !== `Bearer ${this.registration.getHomeserverToken()}`
        ) {
            return false;
        }
        return true;
    }

}

function loadDatabase<T extends BridgeStore>(path: string, cls: new (db: Datastore) => T) {
    const defer = deferPromise<T>();
    var db = new Datastore({
        filename: path,
        autoload: true,
        onload: function(err) {
            if (err) {
                defer.reject(err);
            }
            else {
                defer.resolve(new cls(db));
            }
        }
    });
    return defer.promise;
}

function retryAlgorithm(event: unknown, attempts: number, err: {httpStatus: number, cors?: string, name: string, data?: { retry_after_ms: number }}) {
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
        const waitTime = err.data?.retry_after_ms;
        if (waitTime) {
            return waitTime;
        }
    }
    if (attempts > 4) {
        return -1; // give up
    }
    return 1000 + (1000 * attempts);
}

function queueAlgorithm(event: {getType: () => string, getRoomId(): string}) {
    if (event.getType() === "m.room.message") {
        // use a separate queue for each room ID
        return "message_" + event.getRoomId();
    }
    // allow all other events continue concurrently.
    return null;
}

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
