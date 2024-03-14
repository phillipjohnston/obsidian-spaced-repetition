let debugEnabled: boolean = false; // Set this based on your plugin's settings

function log_debug(msg: any): void {
    if (debugEnabled) {
        console.log(msg);
    }
}

function setLogDebugMode(mode: boolean): void {
    debugEnabled = mode;
}

export { log_debug, setLogDebugMode };
