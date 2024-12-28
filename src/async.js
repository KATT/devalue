import { parse } from "./parse.js";
import { stringify } from "./stringify.js";

/**
 * Checks if a value is a Promise-like object
 * @param {unknown} value The value to check
 * @returns {value is Promise<unknown>} True if the value is a Promise-like object, false otherwise
 */
function isPromise(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

/**
 * Checks if a value is an AsyncIterable object
 * @param {unknown} value The value to check
 * @returns {value is AsyncIterable<unknown>} True if the value is an AsyncIterable, false otherwise
 */
function isAsyncIterable(value) {
  return (
    typeof value === "object" && value !== null && Symbol.asyncIterator in value
  );
}
const PROMISE_STATUS_FULFILLED = 0;
const PROMISE_STATUS_REJECTED = 1;

const ASYNC_ITERABLE_STATUS_YIELD = 0;
const ASYNC_ITERABLE_STATUS_RETURN = 1;
const ASYNC_ITERABLE_STATUS_ERROR = 2;

/**
 * Streams a value into a JSON string that can be parsed with `devalue.parse`
 * @param {unknown} value The value to stream
 * @param {object} [options]
 * @param {Record<string, (value: any) => any>} [options.revivers] Custom revivers to handle special object types
 * @param {(error: unknown) => unknown} [options.coerceError] Function to transform unknown errors to a known error. The known error must be handled by the reviver.
 * @returns {AsyncIterable<string>} An async iterable that yields the streamed value as JSON chunks
 */
export async function* stringifyAsyncIterable(value, options = {}) {
  let counter = 0;

  /** @type {Set<{iterator: AsyncIterator<string>, nextPromise: Promise<IteratorResult<string, string>>}>} */
  const buffer = new Set();

  /**
   * Registers an async iterable callback and returns its index
   * @param {(idx: number) => AsyncIterable<`${string}:${string}:${string}`>} callback The async iterable callback function
   * @returns {number} The index assigned to this callback
   */
  function registerAsyncIterable(callback) {
    const idx = ++counter;

    const iterator = callback(idx)[Symbol.asyncIterator]();

    const nextPromise = iterator.next();

    nextPromise.catch(() => {
      // prevent unhandled promise rejection
    });
    buffer.add({
      iterator,
      nextPromise,
    });

    return idx;
  }

  /** @param {unknown} cause The error cause to safely stringify - prevents interrupting full stream when error is unregistered */
  function safeCause(cause) {
    try {
      return recurse(cause);
    } catch (err) {
      if (!options.coerceError) {
        throw err;
      }
      return recurse(options.coerceError(cause));
    }
  }

  /**
   * Recursively stringifies a value, handling promises specially
   * @param {unknown} v The value to stringify
   * @returns {string} The stringified value
   */
  function recurse(v) {
    return stringify(v, {
      ...options.revivers,
      Promise: (v) => {
        if (!isPromise(v)) {
          return false;
        }
        return registerAsyncIterable(async function* (idx) {
          v.catch(() => {
            // prevent unhandled promise rejection
          });
          try {
            const next = await v;
            return `${idx}:${PROMISE_STATUS_FULFILLED}:${recurse(next)}`;
          } catch (cause) {
            return `${idx}:${PROMISE_STATUS_REJECTED}:${safeCause(cause)}`;
          }
        });
      },
      AsyncIterable: (v) => {
        if (!isAsyncIterable(v)) {
          return false;
        }
        return registerAsyncIterable(async function* (idx) {
          const iterator = v[Symbol.asyncIterator]();
          try {
            while (true) {
              const next = await iterator.next();
              if (next.done) {
                return `${idx}:${ASYNC_ITERABLE_STATUS_RETURN}:${recurse(
                  next.value
                )}`;
              }
              yield `${idx}:${ASYNC_ITERABLE_STATUS_YIELD}:${recurse(
                next.value
              )}`;
            }
          } catch (cause) {
            return `${idx}:${ASYNC_ITERABLE_STATUS_ERROR}:${safeCause(cause)}`;
          } finally {
            await iterator.return?.();
          }
        });
      },
    });
  }

  try {
    yield recurse(value);

    while (buffer.size) {
      // Race all iterators to get the next value from any of them
      const [entry, res] = await Promise.race(
        Array.from(buffer).map(
          async (it) => /** @type {const} */ ([it, await it.nextPromise])
        )
      );

      yield res.value;

      // Remove current iterator and re-add if not done
      buffer.delete(entry);
      if (!res.done) {
        entry.nextPromise = entry.iterator.next();
        buffer.add(entry);
      }
    }
  } finally {
    // Return all iterators
    await Promise.allSettled(
      Array.from(buffer).map((it) => it.iterator.return())
    );
  }
}

function createStreamController() {
  /** @type {ReadableStreamDefaultController<[number, unknown] | Error>} */
  let originalController;

  /** @type {ReadableStream<[number, unknown] | Error>} */
  const stream = new ReadableStream({
    start(controller) {
      originalController = controller;
    },
  });

  return {
    /** @param {[number, unknown] | Error} v */
    enqueue: (v) => originalController.enqueue(v),
    getReader: () => stream.getReader(),
  };
}

/**
 * Converts a string to a number, throwing an error if the conversion fails
 * @param {string} str The string to convert to a number
 * @returns {number} The converted number
 * @throws {Error} If the string cannot be converted to a number
 */
function asNumberOrThrow(str) {
  if (!/^\d+$/.test(str)) {
    throw new Error(`Expected positive number, got ${str}`);
  }
  return parseInt(str, 10);
}

/**
 * Parse an async iterable value serialized with `devalue.stringify`
 * @param {AsyncIterable<string>} value
 * @param {Record<string, (value: any) => any>} [revivers]

 * @returns {Promise<unknown>}
 */
export async function parseAsyncIterable(value, revivers = {}) {
  const iterator = value[Symbol.asyncIterator]();

  /** @type {Map<number, (v: [number, unknown] | Error) => void>} */
  const enqueueMap = new Map();

  /** @param {number} id */
  function registerAsync(id) {
    /** @type {ReadableStreamDefaultController<[number, unknown] | Error>} */
    let originalController;

    /** @type {ReadableStream<[number, unknown] | Error>} */
    const stream = new ReadableStream({
      start(controller) {
        originalController = controller;
      },
    });

    enqueueMap.set(id, (v) => originalController.enqueue(v));

    return stream.getReader();
  }

  /** @param {string} value */
  function recurse(value) {
    return parse(value, {
      ...revivers,
      Promise: async (idx) => {
        const reader = registerAsync(idx);

        try {
          const result = await reader.read();

          if (result.value instanceof Error) {
            throw result.value;
          }

          const [status, value] = result.value;

          if (status === PROMISE_STATUS_FULFILLED) {
            return value;
          }

          throw value;
        } finally {
          await reader.cancel();
          enqueueMap.delete(idx);
        }
      },
      AsyncIterable: async function* (idx) {
        const reader = registerAsync(idx);

        try {
          while (true) {
            const result = await reader.read();

            if (result.done) {
              return;
            }

            if (result.value instanceof Error) {
              throw result.value;
            }

            const [status, value] = result.value;
            switch (status) {
              case ASYNC_ITERABLE_STATUS_YIELD:
                yield value;
                break;
              case ASYNC_ITERABLE_STATUS_RETURN:
                return value;
              case ASYNC_ITERABLE_STATUS_ERROR:
                throw value;
              default: {
                throw new Error(`Unknown status: ${status}`);
              }
            }
          }
        } finally {
          await reader.cancel();
          enqueueMap.delete(idx);
        }
      },
    });
  }

  // will contain the head of the async iterable
  const head = await iterator.next();

  if (!head.done) {
    (async () => {
      while (true) {
        const result = await iterator.next();
        if (result.done) break;

        /** @type {string} */
        let str = result.value;

        let index = str.indexOf(":");
        const idx = asNumberOrThrow(str.slice(0, index));
        str = str.slice(index + 1);

        index = str.indexOf(":");
        const status = asNumberOrThrow(str.slice(0, index));
        str = str.slice(index + 1);

        const value = recurse(str);

        enqueueMap.get(idx)?.([status, value]);
      }
    })().catch((cause) => {
      // go through all the asyncMap and enqueue the error
      for (const [_, enqueue] of enqueueMap) {
        enqueue(
          new Error(
            "Stream interrupted",
            // @ts-ignore
            { cause }
          )
        );
      }
    });
  }

  return recurse(head.value);
}
