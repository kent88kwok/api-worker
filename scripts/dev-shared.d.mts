export interface DevHealthTarget {
	name: string;
	commandName: string;
	url: string;
}

export interface DerivedDevPorts {
	workerPort: number;
	attemptWorkerPort: number;
	uiPort: number;
	workerInspectorPort: number;
	attemptInspectorPort: number;
}

export interface ResidualPortInfo {
	port: number;
	pid: number | null;
	commandLine?: string | null;
	managed?: boolean;
}

export interface DevHealthCheck extends DevHealthTarget {
	ok: boolean;
	status?: number | null;
	error?: string;
}

export function loadDotEnvFile(
	sourceText: string,
	env: Record<string, string | undefined>,
): boolean;

export function buildDevHealthTargets(input: {
	workerPort: number;
	attemptWorkerPort: number;
	skipAttemptWorker: boolean;
}): DevHealthTarget[];

export function deriveDevPorts(input: { basePort: number }): DerivedDevPorts;

export function summarizeHealthChecks(checks: DevHealthCheck[]): {
	healthy: boolean;
	level: string;
	message: string;
	failedChecks: DevHealthCheck[];
};

export function shouldRestartUnhealthyService(input: {
	now: number;
	startedAt: number;
	startupGraceMs: number;
	restartThreshold: number;
	restartCooldownMs: number;
	consecutiveFailures: number;
	lastRestartAt?: number | null;
}): boolean;

export function waitForChildExit(
	child:
		| {
				exitCode: number | null;
				off(eventName: "exit", listener: () => void): void;
				once(eventName: "exit", listener: () => void): void;
		  }
		| null
		| undefined,
	timeoutMs: number,
): Promise<void>;

export function classifyBackgroundDevState(input: {
	pidRunning: boolean;
	healthSummary?: {
		healthy: boolean;
	} | null;
	hasResidualPorts?: boolean;
}): {
	level: string;
	state: string;
	message: string;
};

export function formatBackgroundStatus(input: {
	state: { pid: number } | null;
	healthChecks: DevHealthCheck[];
	residualPorts: ResidualPortInfo[];
	backgroundStatus: {
		level: string;
		state: string;
		message: string;
	};
}): {
	summary: string;
	details?: string[];
};

export function buildStopPlan(input: {
	liveState: { pid: number } | null;
	residualPorts: ResidualPortInfo[];
}):
	| {
			kind: "daemon";
			pids: number[];
			unmanagedPorts: number[];
	  }
	| {
			kind: "residual";
			pids: number[];
			unmanagedPorts: number[];
	  }
	| {
			kind: "noop";
			pids: number[];
			unmanagedPorts: number[];
	  };

export function resolveChildExitSupervisorAction(input: {
	shuttingDown: boolean;
	restarting: boolean;
	isCurrentChild: boolean;
	code: number | null;
	allChildrenExited: boolean;
}):
	| {
			type: "ignore";
	  }
	| {
			type: "shutdown";
			code: number;
	  };
