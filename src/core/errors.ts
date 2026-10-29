export class Fault extends Error {
    constructor(readonly code: string) { super(code); this.name = 'Fault'; }
}
export function reason(error: unknown): string { return error instanceof Fault ? error.code : 'INTERNAL_FAILURE'; }
/** Trusted executor proof that it rejected before any physical operation began. */
export class ExecutionNotStarted extends Fault {
    constructor() { super('STALE_SNAPSHOT'); this.name='ExecutionNotStarted'; }
}
