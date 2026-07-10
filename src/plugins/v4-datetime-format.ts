import type { GraphQLScalarType } from "graphql";

// PostGraphile v4 emitted timestamps in Postgres text style with a "T"
// separator: fractional seconds have their trailing zeros trimmed and are
// omitted entirely when zero ("2028-09-18T20:00:00", "...T06:30:02.067").
// v5 formats via to_char(.., 'US') which always emits 6 fractional digits
// ("...T20:00:00.000000"). Existing clients string-compare / cache these
// values, so normalise Datetime output back to the exact v4 shape.
const trimFraction = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  // trim trailing zeros in the fractional-seconds part, dropping the dot if
  // nothing remains; preserves any timezone suffix (+00, +00:00, Z)
  return value.replace(/\.(\d*?)0+(?=[^\d]|$)/, (_m, keep: string) =>
    keep ? `.${keep}` : ""
  );
};

export const V4DatetimeFormatPlugin: GraphileConfig.Plugin = {
  name: "V4DatetimeFormatPlugin",
  version: "1.0.0",
  description:
    "Serializes Datetime scalars exactly like PostGraphile v4 (trimmed fractional seconds)",
  schema: {
    hooks: {
      finalize(schema) {
        const type = schema.getType("Datetime") as GraphQLScalarType | null;
        if (type && typeof type.serialize === "function") {
          const prev = type.serialize.bind(type);
          type.serialize = (value: unknown) => trimFraction(prev(value));
        }
        return schema;
      },
    },
  },
};
