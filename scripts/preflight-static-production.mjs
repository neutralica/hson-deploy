import { validate_accepted_static_test_evidence } from "./static-test-evidence-config.mjs";

const evidence = validate_accepted_static_test_evidence();
console.log(`Static production preflight: accepted frozen evidence ${evidence.root} with ${evidence.rows} public row artifacts verified.`);
