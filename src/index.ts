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

// Requests
export * from "./components/request";
export * from "./components/request-factory";

export * from "./components/client-factory";
export * from "./components/intent";

export * from "./components/app-service-bot";
export * from "./components/state-lookup";

// Config and CLI
export * from "./components/cli";
export * from "./components/config-validator";

// Store
export * from "./components/bridge-store";
export * from "./components/user-bridge-store";
export * from "./components/room-bridge-store";
export * from "./components/event-bridge-store";

// Models
export * from "./models/rooms/matrix";
export * from "./models/rooms/remote";
export * from "./models/users/matrix";
export * from "./models/users/remote";
export * from "./models/events/event";
export * from "./bridge";
export * from "./components/bridge-context";

export * from "matrix-appservice";
export * from "./components/prometheusmetrics";
export * from "./components/membership-cache";
export * as Logging from "./components/logging";
export { unstable } from "./errors";

/* eslint-disable @typescript-eslint/no-var-requires */
const jsSdk = require("matrix-js-sdk");

export const ContentRepo = {
    getHttpUriForMxc: jsSdk.getHttpUriForMxc,
    getIdenticonUri: jsSdk.getIdenticonUri,
}
