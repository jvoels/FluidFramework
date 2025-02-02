/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { EventEmitter } from "events";
import {
    IDisposable,
    IEvent,
    ITelemetryLogger,
} from "@fluidframework/common-definitions";
import {
    Heap,
    IComparer,
    IHeapNode,
    IPromiseTimerResult,
    PromiseTimer,
    TypedEventEmitter,
} from "@fluidframework/common-utils";
import { ChildLogger, PerformanceEvent } from "@fluidframework/telemetry-utils";
import { IFluidObject, IRequest } from "@fluidframework/core-interfaces";
import {
    IContainerContext,
    LoaderHeader,
} from "@fluidframework/container-definitions";
import { IQuorum, ISequencedClient } from "@fluidframework/protocol-definitions";
import { DriverHeader } from "@fluidframework/driver-definitions";
import { ISummarizer, createSummarizingWarning, ISummarizingWarning } from "./summarizer";

export const summarizerClientType = "summarizer";

interface ITrackedClient {
    clientId: string;
    sequenceNumber: number;
    isSummarizer: boolean;
}

class ClientComparer implements IComparer<ITrackedClient> {
    public readonly min: ITrackedClient = {
        clientId: "",
        sequenceNumber: -1,
        isSummarizer: false,
    };

    public compare(a: ITrackedClient, b: ITrackedClient): number {
        return a.sequenceNumber - b.sequenceNumber;
    }
}

interface IQuorumHeapEvents extends IEvent {
    (event: "heapChange", listener: () => void);
}

class QuorumHeap extends TypedEventEmitter<IQuorumHeapEvents> {
    private readonly heap = new Heap<ITrackedClient>((new ClientComparer()));
    private readonly heapMembers = new Map<string, IHeapNode<ITrackedClient>>();
    private summarizerCount = 0;

    constructor(quorum: IQuorum) {
        super();
        const members = quorum.getMembers();
        for (const [clientId, client] of members) {
            this.addClient(clientId, client);
        }

        quorum.on("addMember", this.addClient);
        quorum.on("removeMember", this.removeClient);
    }

    private readonly addClient = (clientId: string, client: ISequencedClient) => {
        // Have to undefined-check client.details for backwards compatibility
        const isSummarizer = client.client.details?.type === summarizerClientType;
        const heapNode = this.heap.add({ clientId, sequenceNumber: client.sequenceNumber, isSummarizer });
        this.heapMembers.set(clientId, heapNode);
        if (isSummarizer) {
            this.summarizerCount++;
        }
        this.emit("heapChange");
    };

    private readonly removeClient = (clientId: string) => {
        const member = this.heapMembers.get(clientId);
        if (member) {
            this.heap.remove(member);
            this.heapMembers.delete(clientId);
            if (member.value.isSummarizer) {
                this.summarizerCount--;
            }
            this.emit("heapChange");
        }
    };

    public getFirstClientId(): string | undefined {
        return this.heap.count() > 0 ? this.heap.peek().value.clientId : undefined;
    }

    public getSummarizerCount(): number {
        return this.summarizerCount;
    }
}

enum SummaryManagerState {
    Off = 0,
    Starting = 1,
    Running = 2,
    Stopping = 3,
    Disabled = -1,
}

const defaultInitialDelayMs = 5000;
const opsToBypassInitialDelay = 4000;

// Please note that all reasons  in this list are not errors,
// and thus they are not raised today to parent container as error.
// If this needs to be changed in future, we should re-evaluate what and how we raise to summarizer
type StopReason = "parentNotConnected" | "parentShouldNotSummarize" | "disposed";
type ShouldSummarizeState = {
    shouldSummarize: true;
    shouldStart: boolean;
} | {
    shouldSummarize: false;
    stopReason: StopReason;
};

const defaultThrottleDelayWindowMs = 60 * 1000;
const defaultThrottleMaxDelayMs = 30 * 1000;
// default throttling function increases exponentially (0ms, 20ms, 60ms, 140ms, etc)
const defaultThrottleDelayFunction = (n: number) => 20 * (Math.pow(2, n) - 1);

/**
 * Used to give increasing delay times for throttling a single functionality.
 * Delay is based on previous attempts within specified time window, ignoring actual delay time.
 */
class Throttler {
    private startTimes: number[] = [];
    constructor(
        private readonly delayWindowMs,
        private readonly maxDelayMs,
        private readonly delayFunction,
    ) { }

    public get attempts() {
        return this.startTimes.length;
    }

    public getDelay() {
        const now = Date.now();
        this.startTimes = this.startTimes.filter((t) => now - t < this.delayWindowMs);
        const delayMs = Math.min(this.delayFunction(this.startTimes.length), this.maxDelayMs);
        this.startTimes.push(now);
        this.startTimes = this.startTimes.map((t) => t + delayMs); // account for delay time
        if (delayMs === this.maxDelayMs) {
            // we hit max delay so adding more won't affect anything
            // shift off oldest time to stop this array from growing forever
            this.startTimes.shift();
        }

        return delayMs;
    }
}

export class SummaryManager extends EventEmitter implements IDisposable {
    private readonly logger: ITelemetryLogger;
    private readonly quorumHeap: QuorumHeap;
    private readonly initialDelayP: Promise<IPromiseTimerResult | void>;
    private readonly initialDelayTimer?: PromiseTimer;
    private summarizerClientId?: string;
    private clientId?: string;
    private latestClientId?: string;
    private connected = false;
    private state = SummaryManagerState.Off;
    private runningSummarizer?: ISummarizer;
    private _disposed = false;
    private readonly startThrottler = new Throttler(
        defaultThrottleDelayWindowMs,
        defaultThrottleMaxDelayMs,
        defaultThrottleDelayFunction,
    );
    private opsUntilFirstConnect = -1;

    public get summarizer() {
        return this.summarizerClientId;
    }

    public get disposed() {
        return this._disposed;
    }

    constructor(
        private readonly context: IContainerContext,
        private readonly summariesEnabled: boolean,
        parentLogger: ITelemetryLogger,
        initialDelayMs: number = defaultInitialDelayMs,
    ) {
        super();

        this.logger = ChildLogger.create(
            parentLogger,
            "SummaryManager",
            {all:{ clientId: () => this.latestClientId }});

        this.connected = context.connected;
        if (this.connected) {
            this.setClientId(context.clientId);
        }

        context.quorum.on("addMember", (clientId: string, details: ISequencedClient) => {
            if (this.opsUntilFirstConnect === -1 && clientId === this.clientId) {
                this.opsUntilFirstConnect = details.sequenceNumber - this.context.deltaManager.initialSequenceNumber;
            }
        });

        this.quorumHeap = new QuorumHeap(context.quorum);
        this.quorumHeap.on("heapChange", () => { this.refreshSummarizer(); });

        this.initialDelayTimer = new PromiseTimer(initialDelayMs, () => { });
        this.initialDelayP = this.initialDelayTimer?.start() ?? Promise.resolve();

        this.refreshSummarizer();
    }

    public setConnected(clientId: string) {
        this.updateConnected(true, clientId);
    }

    public setDisconnected() {
        this.updateConnected(false);
    }

    private setClientId(clientId: string | undefined): void {
        this.clientId = clientId;
        if (clientId !== undefined) {
            this.latestClientId = clientId;
            if (this.runningSummarizer !== undefined) {
                this.runningSummarizer.updateOnBehalfOf(clientId);
            }
        }
    }

    public on(event: "summarizer", listener: (clientId: string) => void): this;
    public on(event: string, listener: (...args: any[]) => void): this {
        return super.on(event, listener);
    }

    private updateConnected(connected: boolean, clientId?: string) {
        if (this.connected === connected) {
            return;
        }

        this.connected = connected;
        this.setClientId(clientId);
        this.refreshSummarizer();
    }

    private getShouldSummarizeState(): ShouldSummarizeState {
        if (!this.connected) {
            return { shouldSummarize: false, stopReason: "parentNotConnected" };
        } else if (this.clientId !== this.summarizer) {
            return { shouldSummarize: false, stopReason: "parentShouldNotSummarize" };
        } else if (this.disposed) {
            return { shouldSummarize: false, stopReason: "disposed" };
        } else if (this.quorumHeap.getSummarizerCount() > 0) {
            // Need to wait for any other existing summarizer clients to close,
            // because they can live longer than their parent container.
            return { shouldSummarize: true, shouldStart: false };
        } else {
            return { shouldSummarize: true, shouldStart: true };
        }
    }

    private refreshSummarizer() {
        // Compute summarizer
        const newSummarizerClientId = this.quorumHeap.getFirstClientId();
        if (newSummarizerClientId !== this.summarizerClientId) {
            this.summarizerClientId = newSummarizerClientId;
            this.emit("summarizer", newSummarizerClientId);
        }

        // Transition states depending on shouldSummarize, which is a calculated
        // property that is only true if this client is connected and has the
        // computed summarizer client id
        const shouldSummarizeState = this.getShouldSummarizeState();
        switch (this.state) {
            case SummaryManagerState.Off: {
                if (shouldSummarizeState.shouldSummarize && shouldSummarizeState.shouldStart) {
                    this.start();
                }
                return;
            }
            case SummaryManagerState.Starting: {
                // Cannot take any action until summarizer is created
                // state transition will occur after creation
                return;
            }
            case SummaryManagerState.Running: {
                if (shouldSummarizeState.shouldSummarize === false) {
                    this.stop(shouldSummarizeState.stopReason);
                }
                return;
            }
            case SummaryManagerState.Stopping: {
                // Cannot take any action until running summarizer finishes
                // state transition will occur after it stops
                return;
            }
            case SummaryManagerState.Disabled: {
                // Never switch away from disabled state
                return;
            }
            default: {
                return;
            }
        }
    }

    private raiseContainerWarning(warning: ISummarizingWarning) {
        this.context.raiseContainerWarning(warning);
    }

    private start() {
        if (!this.summariesEnabled) {
            // If we should never summarize, lock in disabled state
            this.logger.sendTelemetryEvent({ eventName: "SummariesDisabled" });
            this.state = SummaryManagerState.Disabled;
            return;
        }
        if (this.context.clientDetails.type === summarizerClientType) {
            // Make sure that the summarizer client does not load another summarizer.
            this.state = SummaryManagerState.Disabled;
            return;
        }

        this.state = SummaryManagerState.Starting;

        // throttle creation of new summarizer containers to prevent spamming the server with websocket connections
        const delayMs = this.startThrottler.getDelay();
        if (delayMs >= defaultThrottleMaxDelayMs) {
            // we can't create a summarizer for some reason; raise error on container
            this.raiseContainerWarning(
                createSummarizingWarning("SummaryManager: CreateSummarizer Max Throttle Delay", false));
        }

        this.createSummarizer(delayMs).then((summarizer) => {
            summarizer.on("summarizingError",
                (warning: ISummarizingWarning) => this.raiseContainerWarning(warning));
            this.run(summarizer);
        }, (error) => {
            this.logger.sendErrorEvent({
                eventName: "CreateSummarizerError",
                attempt: this.startThrottler.attempts,
            }, error);
            this.tryRestart();
        });
    }

    private run(summarizer: ISummarizer) {
        this.state = SummaryManagerState.Running;

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const clientId = this.latestClientId!;
        this.runningSummarizer = summarizer;

        PerformanceEvent.timedExecAsync(
            this.logger,
            { eventName: "RunningSummarizer", attempt: this.startThrottler.attempts },
            async () => summarizer.run(clientId),
        ).finally(() => {
            this.runningSummarizer = undefined;
            this.tryRestart();
        });

        const shouldSummarizeState = this.getShouldSummarizeState();
        if (shouldSummarizeState.shouldSummarize === false) {
            this.stop(shouldSummarizeState.stopReason);
        }
    }

    private tryRestart(): void {
        const shouldSummarizeState = this.getShouldSummarizeState();
        if (shouldSummarizeState.shouldSummarize && shouldSummarizeState.shouldStart) {
            this.start();
        } else {
            this.state = SummaryManagerState.Off;
        }
    }

    private stop(reason: string) {
        this.state = SummaryManagerState.Stopping;

        if (this.runningSummarizer) {
            // Stopping the running summarizer client should trigger a change
            // in states when the running summarizer closes
            this.runningSummarizer.stop(reason);
        } else {
            // Should not be possible to hit this case
            this.logger.sendErrorEvent({ eventName: "StopCalledWithoutRunningSummarizer", reason });
            this.state = SummaryManagerState.Off;
        }
    }

    private async createSummarizer(delayMs: number): Promise<ISummarizer> {
        // We have been elected the summarizer. Some day we may be able to summarize with a live document but for
        // now we play it safe and launch a second copy.
        this.logger.sendTelemetryEvent({
            eventName: "CreatingSummarizer",
            delayMs,
            opsUntilFirstConnect: this.opsUntilFirstConnect,
        });

        const shouldDelay = delayMs > 0;
        const shouldInitialDelay = this.opsUntilFirstConnect < opsToBypassInitialDelay;
        if (shouldDelay || shouldInitialDelay) {
            await Promise.all([
                shouldInitialDelay ? this.initialDelayP : Promise.resolve(),
                shouldDelay ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve(),
            ]);
        }

        const loader = this.context.loader;

        // TODO eventually we may wish to spawn an execution context from which to run this
        const request: IRequest = {
            headers: {
                [LoaderHeader.cache]: false,
                [LoaderHeader.clientDetails]: {
                    capabilities: { interactive: false },
                    type: summarizerClientType,
                },
                [DriverHeader.summarizingClient]: true,
                [LoaderHeader.reconnect]: false,
                [LoaderHeader.sequenceNumber]: this.context.deltaManager.lastSequenceNumber,
            },
            url: "/_summarizer",
        };

        const response = await loader.request(request);

        if (response.status !== 200
            || (response.mimeType !== "fluid/object" && response.mimeType !== "fluid/component")) {
            return Promise.reject(new Error("Invalid summarizer route"));
        }

        const rawFluidObject = response.value as IFluidObject;
        const summarizer = rawFluidObject.ISummarizer;

        if (!summarizer) {
            return Promise.reject(new Error("Fluid object does not implement ISummarizer"));
        }

        return summarizer;
    }

    public dispose() {
        this.initialDelayTimer?.clear();
        this._disposed = true;
    }
}
