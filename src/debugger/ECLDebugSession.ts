import { locateAllClientTools, locateClientTools, Workunit } from "@hpcc-js/comms";
import { Graph, IGraphItem, IObserverHandle, Level, logger, scopedLogger, ScopedLogging, Writer } from "@hpcc-js/util";
import os = require("os");
import path = require("path");
import {
    Breakpoint, ContinuedEvent, DebugSession, Event, Handles, InitializedEvent, OutputEvent, Scope, Source,
    StackFrame, StoppedEvent, TerminatedEvent, Thread, ThreadEvent, Variable
} from "vscode-debugadapter";
import { DebugProtocol } from "vscode-debugprotocol";
import { LaunchConfig, LaunchRequestArguments } from "./launchConfig";

class VSCodeServerWriter implements Writer {
    private _owner: DebugSession;

    constructor(owner: DebugSession) {
        this._owner = owner;
    }
    write(dateTime: string, level: Level, id: string, msg: string) {
        this._owner.sendEvent(new OutputEvent(`[${dateTime}] ${Level[level].toUpperCase()} ${id}:  ${msg}`));
    }
}

// tslint:disable-next-line:no-var-requires
require("console-stamp")(console);

class WUStack {
    graphItem: IGraphItem;

    constructor(graphItem: IGraphItem) {
        this.graphItem = graphItem;
    }
}

class WUScope {
    stack: WUStack;
    type: string;

    constructor(stack: WUStack, type: string) {
        this.stack = stack;
        this.type = type;
    }
}

export class ECLDebugSession extends DebugSession {
    workunit: Workunit;
    watchHandle: IObserverHandle;
    launchConfig: LaunchConfig;

    private prevMonitorMessage: string;

    //  Breakpoints  ---
    private _breakpointId = 1000;
    private _breakPoints = new Map<string, DebugProtocol.Breakpoint[]>();
    private _stackFrameHandles = new Handles<WUStack>();
    private _variableHandles = new Handles<WUScope>();

    private _prevDebugSequence: string;

    private logger: ScopedLogging;

    public constructor() {
        super();
        logger.writer(new VSCodeServerWriter(this));
        logger.level(Level.info);
        this.logger = scopedLogger("ECLDebugSession");

        locateAllClientTools();
    }

    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        this.logger.debug("InitializeRequest");
        if (response.body) {
            response.body.supportsConditionalBreakpoints = false;
            response.body.supportsHitConditionalBreakpoints = false;
            response.body.supportsFunctionBreakpoints = false;
            response.body.supportsConfigurationDoneRequest = true;
            response.body.supportsEvaluateForHovers = false;
            response.body.supportsStepBack = false;
            response.body.supportsSetVariable = false;
            response.body.supportsRestartFrame = false;
            response.body.supportsStepInTargetsRequest = false;
            response.body.supportsGotoTargetsRequest = false;
            response.body.supportsCompletionsRequest = false;
            response.body.supportsConfigurationDoneRequest = true;
        }
        this.sendResponse(response);
        this.logger.debug("InitializeResponse");
    }

    protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {
        this.logger.debug("launchRequest:  " + JSON.stringify(args));
        this.launchConfig = new LaunchConfig(args);
        this.sendEvent(new OutputEvent("Locating Client Tools." + os.EOL));
        locateClientTools(this.launchConfig._config.eclccPath, this.launchConfig._config.workspace, this.launchConfig.includeFolders(), this.launchConfig.legacyMode()).then((clientTools) => {
            this.sendEvent(new OutputEvent("Client Tools:  " + clientTools.eclccPath + os.EOL));
            this.sendEvent(new OutputEvent("Generating archive." + os.EOL));
            return clientTools.createArchive(this.launchConfig._config.program);
        }).then((archive) => {
            this.sendEvent(new OutputEvent("Creating workunit." + os.EOL));
            return this.launchConfig.createWorkunit().then((wu) => {
                this.sendEvent(new Event("WUCreated", { ...this.launchConfig._config, wuid: wu.Wuid }));
                const pathParts = path.parse(this.launchConfig._config.program);
                return wu.update({
                    Jobname: pathParts.name,
                    QueryText: archive.content,
                    ApplicationValues: {
                        ApplicationValue: [{
                            Application: "vscode-ecl",
                            Name: "filePath",
                            Value: this.launchConfig._config.program
                        }]
                    }
                });
            });
        }).then((workunit) => {
            this.workunit = workunit;
            this.sendEvent(new OutputEvent("Submitting workunit:  " + workunit.Wuid + os.EOL));
            return workunit.submit(this.launchConfig._config.targetCluster, this.launchConfig.action(), this.launchConfig._config.resultLimit);
        }).then(() => {
            this.sendEvent(new OutputEvent("Submitted:  " + this.launchConfig.wuDetailsUrl(this.workunit.Wuid) + os.EOL));
        }).then(() => {
            this.workunit.watchUntilRunning().then(() => {
                this.sendEvent(new InitializedEvent());
                this.logger.debug("InitializeEvent");
                this.sendEvent(new ThreadEvent("main", 0));
                this.logger.debug("ThreadEvent");
            });
        }).catch((e) => {
            this.sendEvent(new OutputEvent(`Launch failed - ${e}${os.EOL}`));
            this.sendEvent(new TerminatedEvent());
            this.logger.debug("InitializeEvent");
        });

        this.sendResponse(response);
        this.logger.debug("launchResponse");
    }

    private disconnectWorkunit() {
        if (this.workunit.isComplete() || !this.workunit.isDebugging()) {
            return Promise.resolve();
        }
        this.sendEvent(new OutputEvent(`Aborting debug session:  ${this.workunit.Wuid}${os.EOL}`));
        return this.workunit.debugQuit().then(() => {
            return this.workunit.abort();
        }).then(() => {
            return this.workunit.refresh();
        }).catch((e) => {
            this.logger.error("Error disconnecting workunit");
        });
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
        this.logger.debug("DisconnectRequest");
        this.disconnectWorkunit().then(() => {
            if (this.watchHandle) {
                this.watchHandle.release();
                delete this.watchHandle;
            }
            this.sendEvent(new OutputEvent(`Monitoring end:  ${this.workunit.Wuid}${os.EOL}`));
            delete this.workunit;
            this.logger.debug("DisconnectResponse");
            super.disconnectRequest(response, args);
        });
    }

    protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
        this.logger.debug("ConfigurationDoneRequest");
        this.sendEvent(new OutputEvent(`Monitoring:  ${this.workunit.Wuid}.${os.EOL}`));
        this.watchHandle = this.workunit.watch((changes) => {
            const debugState: any = this.workunit.DebugState;
            let id = debugState.edgeId || debugState.nodeId || debugState.graphId;
            id = id ? `(${id})` : "";
            const debugMsg = this.workunit.isDebugging() ? `(${debugState.sequence}) - ${debugState.state}${id}` : "";
            const monitorMsg = `${this.workunit.Wuid}:  ${this.workunit.State}${debugMsg}${os.EOL}`;
            if (this.prevMonitorMessage !== monitorMsg) {
                this.prevMonitorMessage = monitorMsg;
                this.sendEvent(new OutputEvent(monitorMsg));
            }
            if (this.workunit.isComplete()) {
                this.sendEvent(new TerminatedEvent());
                this.logger.debug("TerminatedEvent");
            }
            if (this._prevDebugSequence !== debugState.sequence) {
                this._prevDebugSequence = debugState.sequence;
                switch (debugState.state) {
                    case "created":
                    case "finished":
                    case "graph start":
                    case "graph end":
                    case "edge":
                    case "node":
                    case "exception":
                        this.logger.debug("StoppedEvent");
                        this.sendEvent(new StoppedEvent(debugState.state, 0));
                        break;
                    case "debug_running":
                        break;
                    default:
                }
            }
            this.logger.debug(`Debugging: ${debugState.state} - ${JSON.stringify(debugState)}${os.EOL}`);
        }, true);
        this.sendResponse(response);
        this.logger.debug("ConfigurationDoneResponse");
    }

    protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
        this.logger.debug("SetBreakPointsRequest");
        if (this.workunit.isDebugging() && args.source.path) {
            const sourcePath = args.source.path;
            this.workunit.debugDeleteAllBreakpoints().then(() => {
                return this.workunit.debugBreakpointValid(sourcePath);
            }).then((validBPLocations: any) => {
                // verify breakpoint locations
                const breakpoints: Breakpoint[] = [];
                const clientLines = args.lines;
                if (clientLines) {
                    for (const clientLine of clientLines) {
                        for (const validBPLine of validBPLocations) {
                            if (validBPLine.line >= clientLine) {
                                const bp: DebugProtocol.Breakpoint = new Breakpoint(true, validBPLine.line);
                                bp.id = this._breakpointId++;
                                breakpoints.push(bp);
                                this.workunit.debugBreakpointAdd(validBPLine.id + "_0", "edge", "break");
                                break;
                            }
                        }
                    }
                }
                this.logger.debug(this._breakPoints);
                this._breakPoints.set(sourcePath, breakpoints);

                // send back the actual breakpoint positions
                response.body = {
                    breakpoints
                };
                this.sendResponse(response);
                this.logger.debug("SetBreakPointsRequest");
            });
        } else {
            this.sendResponse(response);
            this.logger.debug("SetBreakPointsRequest");
        }

    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        this.logger.debug("ThreadsRequest");
        const threads: Thread[] = [];
        threads.push(new Thread(0, "main"));
        response.body = {
            threads
        };
        this.sendResponse(response);
    }

    protected pushStackFrame(stackFrames: StackFrame[], graphItem: IGraphItem, def?: any): void {
        const id: number = this._stackFrameHandles.create(new WUStack(graphItem));
        if (def) {
            stackFrames.push(new StackFrame(id, graphItem.id(), new Source("builder", def.file), def.line, def.col));
        } else {
            stackFrames.push(new StackFrame(id, graphItem.id()));
        }
    }

    protected createStackTrace(graph: Graph, type: string, id: string, debugState, stackFrames: StackFrame[]): void {
        switch (type) {
            case "edge":
                const edge = graph.allEdge(id);
                this.pushStackFrame(stackFrames, edge, edge.getNearestDefinition());
                this.createStackTrace(graph, "vertex", edge.sourceID(), debugState, stackFrames);
                break;
            case "vertex":
                const vertex = graph.allVertex(id);
                this.pushStackFrame(stackFrames, vertex, vertex.getNearestDefinition());
                if (vertex.parent) {
                    this.createStackTrace(graph, "subgraph", vertex.parent()!.id(), debugState, stackFrames);
                } else {
                    this.createStackTrace(graph, "workunit", this.workunit.Wuid, debugState, stackFrames);
                }
                break;
            case "subgraph":
                const subgraph = graph.allSubgraph(id);
                if (subgraph) {
                    this.pushStackFrame(stackFrames, subgraph, subgraph.getNearestDefinition(debugState.state === "graph end" || debugState.state === "finished"));
                    if (subgraph.parent()) {
                        this.createStackTrace(graph, "subgraph", subgraph.parent()!.id(), debugState, stackFrames);
                    } else {
                        this.createStackTrace(graph, "workunit", this.workunit.Wuid, debugState, stackFrames);
                    }
                } else {
                    this.createStackTrace(graph, "workunit", this.workunit.Wuid, debugState, stackFrames);
                }
                break;
            case "workunit":
                this.pushStackFrame(stackFrames, graph, { file: this.launchConfig._config.program, col: debugState.state === "finished" ? Number.MAX_SAFE_INTEGER : 0 });
                break;
            default:
        }
    }

    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
        this.logger.debug("StackTraceRequest");
        const stackFrames: StackFrame[] = [];
        if (this.workunit.isDebugging()) {
            this.workunit.debugGraph().then((graph) => {
                const debugState: any = this.workunit.DebugState;
                if (debugState.edgeId) {
                    this.createStackTrace(graph, "edge", debugState.edgeId, debugState, stackFrames);
                } else if (debugState.nodeId) {
                    this.createStackTrace(graph, "vertex", debugState.nodeId, debugState, stackFrames);
                } else if (debugState.graphId) {
                    this.createStackTrace(graph, "subgraph", debugState.graphId, debugState, stackFrames);
                } else {
                    this.createStackTrace(graph, "workunit", this.workunit.Wuid, debugState, stackFrames);
                }
                this.logger.debug("StackTraceResponse");
                response.body = {
                    stackFrames
                };
                this.sendResponse(response);
            }).catch((e) => {
                this.logger.debug("StackTraceResponse");
                response.body = {
                    stackFrames
                };
                this.sendResponse(response);
            });
        } else {
            this.logger.debug("StackTraceResponse");
            response.body = {
                stackFrames
            };
            this.sendResponse(response);
        }
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
        this.logger.debug("ScopesRequest");
        const stackFrameScope: WUStack = this._stackFrameHandles.get(args.frameId);

        const scopes: Scope[] = [];
        switch (stackFrameScope.graphItem.className()) {
            case "Edge":
                scopes.push(new Scope("Results", this._variableHandles.create(new WUScope(stackFrameScope, "results")), false));
                scopes.push(new Scope("Local", this._variableHandles.create(new WUScope(stackFrameScope, "local")), false));
                break;
            case "Vertex":
                scopes.push(new Scope("Local", this._variableHandles.create(new WUScope(stackFrameScope, "local")), false));
                scopes.push(new Scope("Out Edges", this._variableHandles.create(new WUScope(stackFrameScope, "outedges")), false));
                break;
            case "Subgraph":
                scopes.push(new Scope("Local", this._variableHandles.create(new WUScope(stackFrameScope, "local")), false));
                scopes.push(new Scope("Subgraphs", this._variableHandles.create(new WUScope(stackFrameScope, "subgraphs")), false));
                scopes.push(new Scope("Vertices", this._variableHandles.create(new WUScope(stackFrameScope, "vertices")), false));
                break;
            case "XGMMLGraph":
                scopes.push(new Scope("Local", this._variableHandles.create(new WUScope(stackFrameScope, "workunit")), false));
                scopes.push(new Scope("Graphs", this._variableHandles.create(new WUScope(stackFrameScope, "subgraphs")), false));
                scopes.push(new Scope("Debug", this._variableHandles.create(new WUScope(stackFrameScope, "breakpoints")), true));
                break;
            default:
        }
        response.body = {
            scopes
        };
        this.sendResponse(response);
        this.logger.debug("ScopesResponse");
    }

    protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
        this.logger.debug("VariablesRequest");
        const wuScope = this._variableHandles.get(args.variablesReference);
        let variables: Variable[] = [];
        switch (wuScope.type) {
            case "local":
                for (const key in wuScope.stack.graphItem.attrs) {
                    if (wuScope.stack.graphItem.attrs.hasOwnProperty(key)) {
                        variables.push(new Variable(key, "" + wuScope.stack.graphItem.attrs[key]));
                    }
                }
                break;
            case "workunit":
                const state = this.workunit.properties;
                for (const key in state) {
                    if (state.hasOwnProperty(key)) {
                        variables.push(new Variable(key, "" + state[key]));
                    }
                }
                break;
            case "breakpoints":
                this.workunit.debugBreakpointList().then((breakpoints) => {
                    variables = breakpoints.map((breakpoint) => {
                        return new Variable(breakpoint.action + "_" + breakpoint.idx, "" + breakpoint.id);
                    });
                    response.body = {
                        variables
                    };
                    this.sendResponse(response);
                });
                return;
            case "results":
                this.workunit.debugPrint(wuScope.stack.graphItem.id(), 0, 10).then((results) => {
                    variables = results.map((result, idx) => {
                        const summary: any[] = [];
                        const values: any = {};
                        for (const key in result) {
                            if (result.hasOwnProperty(key)) {
                                values[key] = result[key];
                                summary.push(result[key]);
                            }
                        }
                        return new Variable("Row_" + idx, JSON.stringify(summary), this._variableHandles.create(new WUScope(new WUStack(values), "rows")));
                    });
                    response.body = {
                        variables
                    };
                    this.sendResponse(response);
                });
                return;
            case "rows":
                for (const key in wuScope.stack.graphItem) {
                    if (wuScope.stack.graphItem.hasOwnProperty(key)) {
                        variables.push(new Variable(key, "" + wuScope.stack.graphItem[key]));
                    }
                }
                break;
            default:
        }
        response.body = {
            variables
        };
        this.sendResponse(response);
        this.logger.debug("VariablesResponse");
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse): void {
        this.logger.debug("ContinueRequest");
        this.workunit.debugContinue().then((debugResponse) => {
            this.logger.debug("debugContinue.then");
            this.workunit.refresh();
        });
        this.sendEvent(new ContinuedEvent(0));
        this.sendResponse(response);
        this.logger.debug("ContinueResponse");
    }

    protected nextRequest(response: DebugProtocol.NextResponse): void {
        this.logger.debug("NextRequest");
        const debugState: any = this.workunit.DebugState;
        if (debugState.edgeId) {
            this.workunit.debugStep("edge").then(() => {
                this.workunit.refresh();
            });
        } else if (debugState.nodeId) {
            this.workunit.debugStep("edge").then(() => {
                this.workunit.refresh();
            });
        } else if (debugState.graphId) {
            this.workunit.debugStep("graph").then(() => {
                this.workunit.refresh();
            });
        } else {
            this.workunit.debugContinue().then(() => {
                this.workunit.refresh();
            });
        }
        this.sendResponse(response);
        this.logger.debug("NextResponse");
    }

    protected stepInRequest(response: DebugProtocol.StepInResponse): void {
        this.logger.debug("StepInRequest");
        const debugState: any = this.workunit.DebugState;
        if (debugState.edgeId) {
            this.workunit.debugStep("edge").then(() => {
                this.workunit.refresh();
            });
        } else if (debugState.nodeId) {
            this.workunit.debugStep("edge").then(() => {
                this.workunit.refresh();
            });
        } else if (debugState.graphId) {
            this.workunit.debugStep("edge").then(() => {
                this.workunit.refresh();
            });
        } else {
            this.workunit.debugStep("graph").then(() => {
                this.workunit.refresh();
            });
        }
        this.sendResponse(response);
        this.logger.debug("StepInResponse");
    }

    protected stepOutRequest(response: DebugProtocol.StepOutResponse): void {
        this.logger.debug("StepOutRequest");
        const debugState: any = this.workunit.DebugState;
        if (debugState.edgeId) {
            this.workunit.debugStep("graph").then(() => {
                this.workunit.refresh();
            });
        } else if (debugState.nodeId) {
            this.workunit.debugStep("graph").then(() => {
                this.workunit.refresh();
            });
        } else if (debugState.graphId) {
            this.workunit.debugStep("graph").then(() => {
                this.workunit.refresh();
            });
        } else {
            this.workunit.debugContinue().then(() => {
                this.workunit.refresh();
            });
        }
        this.sendResponse(response);
        this.logger.debug("StepOutResponse");
    }

    protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
        this.logger.debug("PauseRequest");
        this._prevDebugSequence = "pauseRequest";
        this.workunit.debugPause().then((debugResponse) => {
            this.workunit.refresh();
        });
        this.sendResponse(response);
        this.logger.debug("PauseResponse");
    }

    protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
        this.logger.debug("EvaluateRequest");
        this.sendResponse(response);
    }
}
