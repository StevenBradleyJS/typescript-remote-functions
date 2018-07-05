import * as t from 'io-ts';

/* Receiving function calls */

export const Payload = t.tuple([
  t.string,
  t.string,
  t.any,
]);

export interface FN<I, O> {
  i: t.Type<I>,
  o: t.Type<O>,
};

interface Registry<C> {
  [key: string]: {
    fn: (ctx: C, msg: any) => Promise<any>,
    type: FN<any, any>,
  };
}

type NamedFnDef<I, O> = () => FN<I, O>;
type AsyncFnCall<C, I, O> = (ctx: C, msg: I) => Promise<O>;

type RegisterFunction<C> =
  <I, O>(type: NamedFnDef<I, O>)
    => (fn: AsyncFnCall<C, I, O>)
      => void;

export class FunctionHandler<C> {

  registry: Registry<C> = {};

  load(loader: (register: RegisterFunction<C>) => void) {
    loader(type =>
      fn => {
        this.registry[type.name] = { type: type(), fn };
      }
    );
  }

  async call(context: C, msg: any): Promise<{ token?: string, result?: any }> {
    const payload = Payload.decode(msg);
    if (payload.isLeft()) throw new Error(`Payload error: ${payload}`);

    const [name, token, args] = payload.value;
    const handler = this.registry[name];
    if (!handler) throw new Error(`Handler missing for ${name}`);

    const input = handler.type.i.decode(args);
    if (input.isLeft()) throw new Error(`Invalid input for ${name}: ${input}`);

    const result = await handler.fn(context, input.value);
    return { token, result };
  }

}

/* Making function calls */

export type Sender<I, O> = (name: string, makeToken: () => string, input: I) => Promise<O>;
type AsyncFN<I, O> = (i: I) => Promise<O>;

/* The time by itself is probably unique enough since Node.js and browsers
   are usually single threaded, but let's add a salt just in case. */
const uuid = () => Date.now().toString() + Math.round(Math.random() * 256).toString(16);

export function realize<I, O>(decl: NamedFnDef<I, O>): (fn: Sender<I, O>) => AsyncFN<I, O> {
  return (send) => (
    async (input) => (
      await send(decl.name, uuid, input)
    )
  );
}
