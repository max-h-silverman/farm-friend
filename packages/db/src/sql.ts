import type postgres from "postgres";

/**
 * The postgres.js client type — the ONE name for it in the repository.
 *
 * ## Why this is not `ReturnType<typeof postgres>` (GL-005)
 *
 * `postgres` is declared as two overloads (`postgres(options)` and `postgres(url, options)`),
 * each returning `Sql<Record<string, PostgresType> extends T ? {} : {…}>` over an unresolved
 * generic `T`. `ReturnType` picks the LAST overload and evaluates that conditional against the
 * *unresolved* `T`, so the type map collapses to `never` — and the tagged-template signature
 * becomes `(template, ...parameters: readonly ParameterOrFragment<never>[])`, which accepts NO
 * parameters at all.
 *
 * The consequence is silent and one-directional: `sql`select ${id}`` fails to typecheck under
 * that alias while working perfectly at runtime, because `ReturnType` describes a client no
 * actual `postgres(url)` call ever produces. Seventeen such errors sat in `apps/web` unseen
 * while the root typecheck did not reference that workspace. Writing the instantiated type
 * directly is what `postgres(url)` genuinely returns, and it binds parameters as intended.
 *
 * Stated once and exported so a future `type Sql = ReturnType<typeof postgres>` has an obvious
 * correct thing to be instead — this used to be redeclared in four modules independently.
 */
export type Sql = postgres.Sql<Record<string, never>>;

/**
 * The transaction handle `Sql["begin"]` hands its callback.
 *
 * Carries the SAME type map as `Sql`, which is the whole point of stating it here rather than
 * in a consumer. Written independently as `TransactionSql<Record<string, unknown>>` it drifted:
 * `unknown` and `never` are contravariantly incompatible in the driver's `types` index
 * signature, so the `tx` the driver actually produced did not satisfy a function expecting the
 * hand-written `Tx`. Both now read from one place, so a change to one is a change to both.
 *
 * (Not `Parameters<Sql["begin"]>` — `begin` is itself overloaded, and `Parameters` would pick
 * the string-options overload, reproducing exactly the inference trap described above.)
 */
export type Tx = postgres.TransactionSql<Record<string, never>>;
