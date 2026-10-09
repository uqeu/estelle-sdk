/** Library surface, so the wizard can be driven from a script as well as a terminal. */
export { detect, alreadyEmitsOtel, type Detection, type Framework } from "./detect.js";
export { buildPlan, type Plan, type Write } from "./plan.js";
export { audit, type AuditResult } from "./audit.js";
