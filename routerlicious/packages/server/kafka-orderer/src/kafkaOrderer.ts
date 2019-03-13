import {
    IClient,
    IClientJoin,
    IDocumentMessage,
    IDocumentSystemMessage,
    MessageType } from "@prague/container-definitions";
import * as core from "@prague/services-core";
import * as _ from "lodash";
import * as moniker from "moniker";

const ordererClientIdStamper: core.IOrdererClientIdStamper = {
    getClientId: (client: IClient) => {
        return moniker.choose();
    },
};

export class KafkaOrdererConnection implements core.IOrdererConnection {
    public static async Create(
        existing: boolean,
        document: core.IDocument,
        producer: core.IProducer,
        tenantId: string,
        documentId: string,
        socket: core.IWebSocket,
        client: IClient,
        maxMessageSize: number,
        clientId: string): Promise<KafkaOrdererConnection> {
        // Create the connection
        const connection = new KafkaOrdererConnection(
            existing,
            document,
            producer,
            tenantId,
            documentId,
            clientId,
            client,
            maxMessageSize);

        // Bind the socket to the channels the connection will send to
        await Promise.all([
            socket.join(`${tenantId}/${documentId}`),
            socket.join(`client#${clientId}`)]);
        return connection;
    }

    public get parentBranch(): string {
        return this._parentBranch;
    }

    // tslint:disable:variable-name
    private _parentBranch: string;
    // tslint:enable:variable-name

    constructor(
        public readonly existing: boolean,
        document: core.IDocument,
        private producer: core.IProducer,
        public readonly tenantId: string,
        public readonly documentId: string,
        public readonly clientId: string,
        private client: IClient,
        public readonly maxMessageSize: number) {

        this._parentBranch = document.parent ? document.parent.documentId : null;

        const clientDetail: IClientJoin = {
            clientId: this.clientId,
            detail: this.client,
        };

        // Back-compat: Replicate the same info in content, metadata, and data.
        const operation: IDocumentSystemMessage = {
            clientSequenceNumber: -1,
            contents: clientDetail,
            data: JSON.stringify(clientDetail),
            metadata: {
                content: clientDetail,
                split: false,
            },
            referenceSequenceNumber: -1,
            traces: [],
            type: MessageType.ClientJoin,
        };

        const message: core.IRawOperationMessage = {
            clientId: null,
            documentId: this.documentId,
            operation,
            tenantId: this.tenantId,
            timestamp: Date.now(),
            type: core.RawOperationType,
        };

        this.submitRawOperation(message);
    }

    public order(message: IDocumentMessage): void {
        const rawMessage: core.IRawOperationMessage = {
            clientId: this.clientId,
            documentId: this.documentId,
            operation: message,
            tenantId: this.tenantId,
            timestamp: Date.now(),
            type: core.RawOperationType,
        };

        this.submitRawOperation(rawMessage);
    }

    public disconnect() {
        // Back-compat: Replicate the same info in content and metadata.
        const operation: IDocumentSystemMessage = {
            clientSequenceNumber: -1,
            contents: this.clientId,
            data: JSON.stringify(this.clientId),
            metadata: {
                content: this.clientId,
                split: false,
            },
            referenceSequenceNumber: -1,
            traces: [],
            type: MessageType.ClientLeave,
        };
        const message: core.IRawOperationMessage = {
            clientId: null,
            documentId: this.documentId,
            operation,
            tenantId: this.tenantId,
            timestamp: Date.now(),
            type: core.RawOperationType,
        };

        this.submitRawOperation(message);
    }

    private submitRawOperation(message: core.IRawOperationMessage) {
        // Add trace
        const operation = message.operation as IDocumentMessage;
        if (operation && operation.traces === undefined) {
            operation.traces = [];
        } else if (operation && operation.traces && operation.traces.length > 1) {
            operation.traces.push(
                {
                    action: "end",
                    service: "alfred",
                    timestamp: Date.now(),
                });
        }

        this.producer.send(message, this.tenantId, this.documentId);
    }
}

export class KafkaOrderer implements core.IOrderer {
    public static async Create(
        storage: core.IDocumentStorage,
        producer: core.IProducer,
        tenantId: string,
        documentId: string,
        maxMessageSize: number,
        clientIdStamper: core.IOrdererClientIdStamper = ordererClientIdStamper): Promise<KafkaOrderer> {

        const details = await storage.getOrCreateDocument(tenantId, documentId);
        return new KafkaOrderer(details, producer, tenantId, documentId, maxMessageSize, clientIdStamper);
    }

    private existing: boolean;

    constructor(
        private details: core.IDocumentDetails,
        private producer: core.IProducer,
        private tenantId: string,
        private documentId: string,
        private maxMessageSize: number,
        private clientIdStamper: core.IOrdererClientIdStamper) {
        this.existing = details.existing;
    }

    public async connect(
        socket: core.IWebSocket,
        client: IClient): Promise<core.IOrdererConnection> {

        const connection = KafkaOrdererConnection.Create(
            this.existing,
            this.details.value,
            this.producer,
            this.tenantId,
            this.documentId,
            socket,
            client,
            this.maxMessageSize,
            this.clientIdStamper.getClientId(client));

        // document is now existing regardless of the original value
        this.existing = true;

        return connection;
    }

    public close() {
        return Promise.resolve();
    }
}

export class KafkaOrdererFactory {
    private ordererMap = new Map<string, Promise<core.IOrderer>>();

    constructor(
        private producer: core.IProducer,
        private storage: core.IDocumentStorage,
        private maxMessageSize: number) {
    }

    public async create(tenantId: string, documentId: string): Promise<core.IOrderer> {
        const fullId = `${tenantId}/${documentId}`;
        if (!this.ordererMap.has(fullId)) {
            const orderer = KafkaOrderer.Create(
                this.storage,
                this.producer,
                tenantId,
                documentId,
                this.maxMessageSize);
            this.ordererMap.set(fullId, orderer);
        }

        return this.ordererMap.get(fullId);
    }
}
