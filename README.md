# TypeScript Function Calls

This library lets you define function interfaces in a file shared between your server code and client code, and call functions between them.

Main features:

- Full type safety
- Deep IDE integration
- No code generation
- No need for code duplication especially for shared types
- Transport agnostic (works with socket.io, express.js, fetch, ...)

### Deeper explanation

Say you're making a real-time chat app. You're going to need to pass lots of types of messages between a lot of remotes:

- Client to Server, response needed ("SendChatMessage")
- Client to Server, response ignored ("ChangedTheme")
- Server to One Client, response needed ("AskUserToUpgrade" I guess?)
- Server to One Client, response ignored ("UserSentChatMessage")
- Server to All Clients, response needed (can't think of a good example here)
- Server to All Clients, response ignored ("UserJoined")

So there's two parts to this:

1. Function receiver - implements functions, and specifies how to receive and reply to them with the function result.

2. Function sender - calls functions, passing arguments, and specifies how to send them and receive responses.

*Both* the server and client will probably implement *both* of these! Because of that, this library is kind of medium-level. It's not really low-level since  I took care of that ugly stuff for you. But it also can't get any higher level than it is without making decisions for you about what your stack would look like.

But as it is right now, it's really easy to drop it in and integrate it into your stack:

### Example

This example uses Express and Socket.io (but you can use it with anything).

`Shared.ts`

```typescript
/* Shared function signature definitions */

export const Calls = {

  ConvertToNumber: () => ({
    i: t.string,
    o: t.number,
  }),

  AddTwoNumbers: () => ({
    i: t.type({
      a: t.number,
      b: t.number,
    }),
    o: t.number,
  }),

};
```

`Server.ts`

```typescript
import express from 'express';
import http from 'http';
import socketio from 'socket.io';
import { Calls, FunctionHandler } from './Shared';

/* The usual setup stuff */

const app = express();
const server = new http.Server(app);
const io = socketio(server);

interface Context {
  socket: socketio.Socket;
  io: socketio.Server;
}

/* Transport agnostic implementation */

const handler = new FunctionHandler<Context>();

handler.load(register => {

  register(Calls.ConvertToNumber)
    (async ({ io, socket }, msg) => {
      return parseFloat(msg);
    });

  register(Calls.Add)
    (async ({ io, socket }, { a, b }) => {
      return a + b;
    });

});

/* Transport specific integration */

io.on('connection', function (socket) {
  socket.on('fn', async (msg) => {
    const { token, result } = await handler.call({ socket, io }, msg);
    if (token === '') socket.emit(token, result);
    // passing the empty string is the convention for ignoring responses
  });

});

server.listen(8000, () => {
  console.log('listening on 8000');
});
```

`Client.tsx`

```typescript
import * as io from 'socket.io-client';
import { Calls, FN, Payload, realize, Sender } from './Shared';


/* Tranport logic. Here, you can separate the logic of what is sent,
   from how it's sent and who it's sent to. Create as many types of
   functions as you need for this job. */

const socket = io();

const sendToOne: Sender<any, any> = (name, makeToken, input) => {
  const token = makeToken();
  this.socket.emit('fn', Payload.encode([name, token, input]));

  if (token) {
    return new Promise(resolve => {
      this.socket.once(token, (result: any) => {
        resolve(result);
      });
    });
  }

  return Promise.resolve(undefined);
};

/* Wrap the function and pass the returned function anywhere you want. */

const add = realize(Calls.Add)(sendToOne);

/* Call it safely from any place in your app! */

const c = await add({ a: 1, b: 2 });
```

### Setup

You'll have to put the `Shared.ts` file somewhere both server and client can access. One idea is to put it into one project and symlink it into the other project.

Since this isn't a full fledged library (yet?), you have to install dependencies on both client and server:

```sh
$ npm i -P io-ts
$ npm i -D @types/io-ts
```

### The shared code file

`Shared.ts`

```typescript
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
```