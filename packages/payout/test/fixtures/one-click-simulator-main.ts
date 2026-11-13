/**
 * Runs the local 1Click simulator as its own process for the browser tests
 * (apps/web/playwright.cashout.config.ts). Loopback only; the port comes from ONE_CLICK_SIM_PORT.
 */
import { OneClickSimulator } from "./one-click-simulator.js";

const port = Number(process.env["ONE_CLICK_SIM_PORT"] ?? 9024);
const sim = new OneClickSimulator();
const url = await sim.start(port);
process.stdout.write(`${JSON.stringify({ event: "one-click-simulator", url })}\n`);
const stop = () => void sim.stop().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
