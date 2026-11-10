import { fixtureRunner } from "./maintenance-fixture";
const run = fixtureRunner(process.argv[2]!);
console.log(JSON.stringify(await run(process.argv[3]!)));
