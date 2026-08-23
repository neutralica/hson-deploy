import { execFileSync } from "node:child_process";

function run(command, args) {
    return execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}

const submodules = [
    "hson-live",
    "hson-demo2",
    "intrastructure",
];

for (const path of submodules) {
    const expected = run("git", [
        "ls-tree",
        "HEAD",
        path,
    ]).split(/\s+/)[2];

    const actual = run("git", [
        "-C",
        path,
        "rev-parse",
        "HEAD",
    ]);

    if (!expected) {
        throw new Error(`Missing gitlink for ${path}`);
    }

    if (expected !== actual) {
        throw new Error(
            [
                `Submodule drift: ${path}`,
                `expected: ${expected}`,
                `actual:   ${actual}`,
                "",
                "Update the parent gitlink or restore the expected checkout.",
            ].join("\n"),
        );
    }

    const status = run("git", [
        "-C",
        path,
        "status",
        "--porcelain",
    ]);

    if (status) {
        throw new Error(
            `Dirty submodule: ${path}\n${status}`,
        );
    }

    console.log(`verified ${path}: ${actual}`);
}