// Per-beam state a stage keeps in the Grid: its typed arrays (one value per beam), declared next to the
// code that owns them. grid.ts allocates them and, for `reset` states, zeroes them on resetHistory().
type ArrayCtor = Float32ArrayConstructor | Uint8ArrayConstructor | Uint16ArrayConstructor | Uint32ArrayConstructor | Int32ArrayConstructor;
type Instance<C> = C extends Float32ArrayConstructor ? Float32Array : C extends Uint8ArrayConstructor ? Uint8Array
  : C extends Uint16ArrayConstructor ? Uint16Array : C extends Uint32ArrayConstructor ? Uint32Array : Int32Array;

export interface BeamState<F extends Record<string, ArrayCtor> = Record<string, ArrayCtor>> {
  fields: F;
  /** forgotten with the per-beam history (seek, source switch, preset change) */
  reset: boolean;
}

/** the Grid fields a BeamState adds */
export type StateFields<S> = S extends BeamState<infer F> ? { [K in keyof F]: Instance<F[K]> } : never;

export const beamState = <F extends Record<string, ArrayCtor>>(fields: F, opts: { reset: boolean }): BeamState<F> =>
  ({ fields, reset: opts.reset });
