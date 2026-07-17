/**
 * pdf.js (modern build) uses Map.prototype.getOrInsertComputed, which is
 * missing in older Safari/Chrome. Polyfill once for the main thread.
 */
export function installMapUpsertPolyfill(): void {
  const proto = Map.prototype as Map<unknown, unknown> & {
    getOrInsertComputed?: (
      key: unknown,
      callbackFn: (key: unknown) => unknown,
    ) => unknown;
    getOrInsert?: (key: unknown, defaultValue: unknown) => unknown;
  };

  if (typeof proto.getOrInsertComputed !== "function") {
    Object.defineProperty(proto, "getOrInsertComputed", {
      value(key: unknown, callbackFn: (key: unknown) => unknown) {
        if (this.has(key)) return this.get(key);
        const value = callbackFn(key);
        this.set(key, value);
        return value;
      },
      writable: true,
      configurable: true,
    });
  }

  if (typeof proto.getOrInsert !== "function") {
    Object.defineProperty(proto, "getOrInsert", {
      value(key: unknown, defaultValue: unknown) {
        if (this.has(key)) return this.get(key);
        this.set(key, defaultValue);
        return defaultValue;
      },
      writable: true,
      configurable: true,
    });
  }
}

installMapUpsertPolyfill();
