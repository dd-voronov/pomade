// E-034 e2e — a test keeper: pomade-kit's keeper library, run on Pomade's Electron binary as Node
// (as an app's always-on backend runs it). Identity and socket come from the environment the spec
// starts it with; the owner needs no key.
import { runKeeper } from 'pomade-kit/keeper'

await runKeeper({ ownerKey: null, version: process.argv[2] ?? 'test' })
