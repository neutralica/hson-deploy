import { validate_accepted_static_test_evidence } from "./static-test-evidence-config.mjs";
import { validate_livehost_browser_configuration } from "./livehost-browser-config.mjs";

const evidence = validate_accepted_static_test_evidence();
const liveHost = validate_livehost_browser_configuration();
console.log(`Static production preflight: accepted frozen evidence ${evidence.root} with ${evidence.rows} public row artifacts and LiveHost origin ${liveHost.origin} verified.`);
