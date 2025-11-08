/** @type {import('@electron-forge/shared-types').ForgeConfig} */
module.exports = {
    packagerConfig: {
        asar: true,
        executableName: "Transcript",
    },
    rebuildConfig: {},
    extraResource:[".env"],
    makers: [
        {
            name: "@electron-forge/maker-squirrel",
            config: {
                name: "transcript",
                setupExe: "TranscriptSetup.exe",
            },
        },
        {
            name: "@electron-forge/maker-zip",
            platforms: ["darwin", "linux"],
        },
    ],
    plugins: [
        {
            name: "@electron-forge/plugin-auto-unpack-natives",
            config: {}
        },
    ],
};
