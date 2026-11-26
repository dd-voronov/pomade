// Pomade e2e — assertion helpers that hand back what they checked.
//
// A spec often needs a value Playwright types as nullable — a `boundingBox()`, an element handle,
// a `find()` over a store snapshot — right after the step that guarantees it exists. `present`
// asserts it is there (failing with the given description in the report) and returns it non-null,
// so the test body reads straight down with no branch of its own.

import { expect } from '@playwright/test'

/** Assert `value` is neither `null` nor `undefined` and return it narrowed. */
export function present<T>(value: T, what: string): NonNullable<T> {
  expect(value, `${what}: expected a value`).not.toBeUndefined()
  expect(value, `${what}: expected a value`).not.toBeNull()
  return value as NonNullable<T>
}
