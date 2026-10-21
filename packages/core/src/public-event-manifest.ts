export * as PublicEventManifest from "./public-event-manifest"

import { Event } from "@sixfinger/schema/event"
import { EventManifest } from "@sixfinger/schema/event-manifest"

export const Definitions = EventManifest.ServerDefinitions
export const Latest = Event.latest(Definitions)
