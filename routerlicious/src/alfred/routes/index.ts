import { Router } from "express";
import { Provider } from "nconf";
import { ITenantManager } from "../../api-core";
import * as utils from "../../utils";
import * as agent from "./agent";
import * as api from "./api";
import * as canvas from "./canvas";
import * as cell from "./cell";
import * as demoCreator from "./democreator";
import * as graph from "./graph";
import * as home from "./home";
import * as intelligence from "./intelligence";
import * as login from "./login";
import * as maps from "./maps";
import * as ping from "./ping";
import * as scribe from "./scribe";
import * as sharedText from "./sharedText";
import * as templates from "./templates";
import * as video from "./video";
import * as youtubeVideo from "./youtubeVideo";

export interface IRoutes {
    agent: Router;
    api: Router;
    canvas: Router;
    cell: Router;
    demoCreator: Router;
    home: Router;
    intelligence: Router;
    login: Router;
    maps: Router;
    scribe: Router;
    sharedText: Router;
    video: Router;
    youtubeVideo: Router;
    graph: Router;
    templates: Router;
}

export function create(
    config: Provider,
    tenantManager: ITenantManager,
    mongoManager: utils.MongoManager,
    producer: utils.kafkaProducer.IProducer) {

    return {
        agent: agent.create(config),
        api: api.create(config, tenantManager, mongoManager, producer),
        canvas: canvas.create(config, tenantManager),
        cell: cell.create(config, tenantManager),
        demoCreator: demoCreator.create(config),
        graph: graph.create(config, tenantManager),
        home: home.create(config),
        intelligence: intelligence.create(config),
        login: login.create(config),
        maps: maps.create(config, tenantManager),
        ping: ping.create(),
        scribe: scribe.create(config),
        sharedText: sharedText.create(config, tenantManager, mongoManager, producer),
        templates: templates.create(config),
        video: video.create(config, tenantManager),
        youtubeVideo: youtubeVideo.create(config, tenantManager),
    };
}
