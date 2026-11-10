// service/main.ts
import http from "node:http";
// node_modules/@openchamber/sdk/dist/scrollbar-style.js
var GUEST_SCROLLING_ATTRIBUTE = "data-oc-scrolling";
var GUEST_SCROLLBAR_CSS = `
:root {
  /* Quiet at rest like the app's own thumbs; hover gives a clear grab target. */
  --oc-scrollbar-thumb: color-mix(in srgb, var(--oc-muted, currentColor) 18%, transparent);
  --oc-scrollbar-thumb-hover: color-mix(in srgb, var(--oc-muted, currentColor) 36%, transparent);
  scrollbar-gutter: stable;
}
* {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
:hover, [${GUEST_SCROLLING_ATTRIBUTE}] {
  scrollbar-color: var(--oc-scrollbar-thumb) transparent;
}
/* Chromium's standard scrollbar properties otherwise override its pseudo-elements. */
@supports selector(::-webkit-scrollbar) {
  *, :hover, [${GUEST_SCROLLING_ATTRIBUTE}] { scrollbar-width: auto; scrollbar-color: auto; }
  ::-webkit-scrollbar { width: 6px; height: 6px; background: transparent; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: transparent;
    border-radius: 999px;
    min-width: 24px;
    min-height: 24px;
  }
  :hover::-webkit-scrollbar-thumb, [${GUEST_SCROLLING_ATTRIBUTE}]::-webkit-scrollbar-thumb { background: var(--oc-scrollbar-thumb); }
  ::-webkit-scrollbar-thumb:hover { background: var(--oc-scrollbar-thumb-hover); }
  ::-webkit-scrollbar-corner { background: transparent; }
  ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
}
@media (forced-colors: active) {
  *, :hover, [${GUEST_SCROLLING_ATTRIBUTE}] { scrollbar-color: auto; }
  ::-webkit-scrollbar-thumb, ::-webkit-scrollbar-thumb:hover { background: CanvasText; }
}
`;
function installGuestScrollbarActivity(doc) {
  const root = doc.documentElement;
  if (root.hasAttribute("data-oc-scrollbar-activity"))
    return;
  root.setAttribute("data-oc-scrollbar-activity", "");
  const timers = new WeakMap;
  doc.addEventListener("scroll", (event) => {
    const target = event.target === doc ? root : event.target;
    if (!(target instanceof Element))
      return;
    if (!target.hasAttribute("data-oc-scrolling"))
      target.setAttribute("data-oc-scrolling", "");
    const pending = timers.get(target);
    if (pending !== undefined)
      clearTimeout(pending);
    timers.set(target, setTimeout(() => {
      timers.delete(target);
      target.removeAttribute("data-oc-scrolling");
    }, 1000));
  }, { capture: true, passive: true });
}
var GUEST_SCROLLBAR_SCRIPT = `(${installGuestScrollbarActivity.toString()})(document);`;
// node_modules/@openchamber/sdk/dist/manifest.js
var TRACKER_URL_TOKENS = ["{id}", "{segment}", "{segments+}"];
var TRACKER_URL_TOKEN_SET = new Set(TRACKER_URL_TOKENS);
// node_modules/@openchamber/sdk/dist/session-events.js
var GUEST_SESSION_EVENT_TYPES = [
  "turn-finished",
  "turn-failed",
  "permission-asked",
  "question-asked",
  "turn-started",
  "session-created",
  "session-archived",
  "session-deleted"
];
var SESSION_EVENTS_IDLE_MS = 10 * 60000;
var EVENT_TYPES = new Set(GUEST_SESSION_EVENT_TYPES);
// node_modules/@openchamber/sdk/dist/service-host.js
var SERVICE_HOST_PATH = "/service/call";
var OPENCHAMBER_HOST_CALLBACK_URL_ENV = "OPENCHAMBER_HOST_CALLBACK_URL";
var SERVICE_HOST_TIMEOUT_MS = 30000;
var SERVICE_SCHEDULE_IDLE_MS = 10 * 60000;
var MENTIONS_IDLE_MS = 10 * 60000;
class ServiceHostError extends Error {
  code;
  status;
  constructor(message, code, status) {
    super(message);
    this.name = "ServiceHostError";
    this.code = code;
    this.status = status;
  }
}
var createServiceHost = ({ env }) => {
  const call = async (method, input) => {
    const base = env[OPENCHAMBER_HOST_CALLBACK_URL_ENV];
    const token = env.OPENCHAMBER_SERVICE_TOKEN;
    if (!base || !token)
      throw new ServiceHostError("This service was not started by OpenChamber.", "HOST_UNAVAILABLE", 0);
    let response;
    try {
      response = await fetch(`${base.replace(/\/+$/, "")}${SERVICE_HOST_PATH}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ method, input }),
        signal: AbortSignal.timeout(SERVICE_HOST_TIMEOUT_MS)
      });
    } catch {
      throw new ServiceHostError("OpenChamber did not answer.", "HOST_UNAVAILABLE", 0);
    }
    const body = await response.json().catch(() => null);
    if (response.ok && body?.result !== undefined)
      return body.result;
    throw new ServiceHostError(body?.error?.message ?? `OpenChamber answered HTTP ${response.status}.`, body?.error?.code ?? "HOST_UNAVAILABLE", response.status);
  };
  return {
    sessions: {
      start: (input) => call("sessions.start", input),
      send: (sessionId, prompt) => call("sessions.send", { sessionId, prompt }),
      retry: (sessionId) => call("sessions.retry", { sessionId }),
      status: (sessionId) => call("sessions.status", { sessionId }),
      lastReply: (sessionId) => call("sessions.lastReply", { sessionId }),
      stop: (sessionId) => call("sessions.stop", { sessionId }),
      answerPermission: (sessionId, requestId, answer) => call("sessions.answerPermission", { sessionId, requestId, ...answer }),
      answerForm: (sessionId, formId, values, message) => call("sessions.answerForm", { sessionId, formId, values, ...message === undefined ? {} : { message } })
    },
    setInstructions: (directory, text) => call("instructions.set", { directory, text }),
    emit: (topic, data) => call("panels.emit", { topic, data }),
    readSettings: () => call("settings.read", {}).then(({ settings }) => settings),
    needsConfiguration: (message) => call("status.set", { needsConfiguration: message })
  };
};
// node_modules/@openchamber/sdk/dist/file-editor.js
var patternExpressions = new Map;
// node_modules/@openchamber/sdk/dist/contract.js
var GUEST_FILE_STAT_KINDS = ["file", "directory", "other", "missing"];
var GUEST_GENERATE_LATE_KEEP_MS = 60 * 60000;
var HOST_REQUEST_ERROR_CODES = [
  "HOST_UNAVAILABLE",
  "HOST_TIMEOUT",
  "HOST_REJECTED",
  "DISCONNECTED",
  "DISABLED",
  "BAD_PATH",
  "NO_INTEGRATION",
  "NO_SERVICE",
  "SERVICE_FAILED",
  "REQUEST_FAILED",
  "RESPONSE_TOO_LARGE",
  "NO_SESSION",
  "SESSION_BUSY",
  "NOT_GRANTED",
  "NO_DIRECTORY",
  "NOT_FOUND",
  "FILE_TOO_LARGE",
  "DENIED",
  "NO_MODEL",
  "MODEL_FAILED",
  "UNSUPPORTED"
];
var SERVICE_STATUS_VALUES = ["stopped", "starting", "ready", "failed"];
var hostRequestErrorCodeSet = new Set(HOST_REQUEST_ERROR_CODES);
var serviceStatusSet = new Set(SERVICE_STATUS_VALUES);
var fileStatKindSet = new Set(GUEST_FILE_STAT_KINDS);
var HOST_PUSH_TYPES = new Set([
  "workspace",
  "shells",
  "ready",
  "directory",
  "session",
  "connection",
  "settings",
  "session-lifecycle",
  "item",
  "resolve",
  "action",
  "service-event",
  "status-control-event",
  "popover-closed",
  "file-open",
  "file-snapshot",
  "file-saved",
  "generate-late"
]);
// node_modules/@openchamber/sdk/dist/service-providers.js
var BROWSER_CONTROL_ACTIONS = [
  "browser.open",
  "browser.snapshot",
  "browser.click",
  "browser.type",
  "browser.select",
  "browser.scroll",
  "browser.back",
  "browser.forward",
  "browser.inspect",
  "browser.capture",
  "browser.resize",
  "browser.close"
];
var BROWSER_PROVIDER_IDLE_MS = 10 * 60000;
var CONTROL_ACTIONS = new Set(BROWSER_CONTROL_ACTIONS);
var SOURCE_CONTROL_PROVIDER_IDLE_MS = 10 * 60000;
var NOTIFICATIONS_PROVIDER_IDLE_MS = 10 * 60000;
var TRACKER_PROVIDER_IDLE_MS = 10 * 60000;
var QUOTA_PROVIDER_IDLE_MS = 10 * 60000;
// node_modules/@openchamber/sdk/dist/service-surface.js
var SURFACE_CONTROLLERS = ["none", "agent", "user"];
var CONTROLLERS = new Set(SURFACE_CONTROLLERS);
// service/manager.ts
import { readFile as readFile2, writeFile as writeFile2, mkdir, rename, copyFile, readdir, rm, open as open2, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path2 from "node:path";
import { createHash, randomBytes } from "node:crypto";

// node_modules/jsonc-parser/lib/esm/impl/scanner.js
function createScanner(text, ignoreTrivia = false) {
  const len = text.length;
  let pos = 0, value = "", tokenOffset = 0, token = 16, lineNumber = 0, lineStartOffset = 0, tokenLineStartOffset = 0, prevTokenLineStartOffset = 0, scanError = 0;
  function scanHexDigits(count, exact) {
    let digits = 0;
    let value2 = 0;
    while (digits < count || !exact) {
      let ch = text.charCodeAt(pos);
      if (ch >= 48 && ch <= 57) {
        value2 = value2 * 16 + ch - 48;
      } else if (ch >= 65 && ch <= 70) {
        value2 = value2 * 16 + ch - 65 + 10;
      } else if (ch >= 97 && ch <= 102) {
        value2 = value2 * 16 + ch - 97 + 10;
      } else {
        break;
      }
      pos++;
      digits++;
    }
    if (digits < count) {
      value2 = -1;
    }
    return value2;
  }
  function setPosition(newPosition) {
    pos = newPosition;
    value = "";
    tokenOffset = 0;
    token = 16;
    scanError = 0;
  }
  function scanNumber() {
    let start = pos;
    if (text.charCodeAt(pos) === 48) {
      pos++;
    } else {
      pos++;
      while (pos < text.length && isDigit(text.charCodeAt(pos))) {
        pos++;
      }
    }
    if (pos < text.length && text.charCodeAt(pos) === 46) {
      pos++;
      if (pos < text.length && isDigit(text.charCodeAt(pos))) {
        pos++;
        while (pos < text.length && isDigit(text.charCodeAt(pos))) {
          pos++;
        }
      } else {
        scanError = 3;
        return text.substring(start, pos);
      }
    }
    let end = pos;
    if (pos < text.length && (text.charCodeAt(pos) === 69 || text.charCodeAt(pos) === 101)) {
      pos++;
      if (pos < text.length && text.charCodeAt(pos) === 43 || text.charCodeAt(pos) === 45) {
        pos++;
      }
      if (pos < text.length && isDigit(text.charCodeAt(pos))) {
        pos++;
        while (pos < text.length && isDigit(text.charCodeAt(pos))) {
          pos++;
        }
        end = pos;
      } else {
        scanError = 3;
      }
    }
    return text.substring(start, end);
  }
  function scanString() {
    let result = "", start = pos;
    while (true) {
      if (pos >= len) {
        result += text.substring(start, pos);
        scanError = 2;
        break;
      }
      const ch = text.charCodeAt(pos);
      if (ch === 34) {
        result += text.substring(start, pos);
        pos++;
        break;
      }
      if (ch === 92) {
        result += text.substring(start, pos);
        pos++;
        if (pos >= len) {
          scanError = 2;
          break;
        }
        const ch2 = text.charCodeAt(pos++);
        switch (ch2) {
          case 34:
            result += '"';
            break;
          case 92:
            result += "\\";
            break;
          case 47:
            result += "/";
            break;
          case 98:
            result += "\b";
            break;
          case 102:
            result += "\f";
            break;
          case 110:
            result += `
`;
            break;
          case 114:
            result += "\r";
            break;
          case 116:
            result += "\t";
            break;
          case 117:
            const ch3 = scanHexDigits(4, true);
            if (ch3 >= 0) {
              result += String.fromCharCode(ch3);
            } else {
              scanError = 4;
            }
            break;
          default:
            scanError = 5;
        }
        start = pos;
        continue;
      }
      if (ch >= 0 && ch <= 31) {
        if (isLineBreak(ch)) {
          result += text.substring(start, pos);
          scanError = 2;
          break;
        } else {
          scanError = 6;
        }
      }
      pos++;
    }
    return result;
  }
  function scanNext() {
    value = "";
    scanError = 0;
    tokenOffset = pos;
    lineStartOffset = lineNumber;
    prevTokenLineStartOffset = tokenLineStartOffset;
    if (pos >= len) {
      tokenOffset = len;
      return token = 17;
    }
    let code = text.charCodeAt(pos);
    if (isWhiteSpace(code)) {
      do {
        pos++;
        value += String.fromCharCode(code);
        code = text.charCodeAt(pos);
      } while (isWhiteSpace(code));
      return token = 15;
    }
    if (isLineBreak(code)) {
      pos++;
      value += String.fromCharCode(code);
      if (code === 13 && text.charCodeAt(pos) === 10) {
        pos++;
        value += `
`;
      }
      lineNumber++;
      tokenLineStartOffset = pos;
      return token = 14;
    }
    switch (code) {
      case 123:
        pos++;
        return token = 1;
      case 125:
        pos++;
        return token = 2;
      case 91:
        pos++;
        return token = 3;
      case 93:
        pos++;
        return token = 4;
      case 58:
        pos++;
        return token = 6;
      case 44:
        pos++;
        return token = 5;
      case 34:
        pos++;
        value = scanString();
        return token = 10;
      case 47:
        const start = pos - 1;
        if (text.charCodeAt(pos + 1) === 47) {
          pos += 2;
          while (pos < len) {
            if (isLineBreak(text.charCodeAt(pos))) {
              break;
            }
            pos++;
          }
          value = text.substring(start, pos);
          return token = 12;
        }
        if (text.charCodeAt(pos + 1) === 42) {
          pos += 2;
          const safeLength = len - 1;
          let commentClosed = false;
          while (pos < safeLength) {
            const ch = text.charCodeAt(pos);
            if (ch === 42 && text.charCodeAt(pos + 1) === 47) {
              pos += 2;
              commentClosed = true;
              break;
            }
            pos++;
            if (isLineBreak(ch)) {
              if (ch === 13 && text.charCodeAt(pos) === 10) {
                pos++;
              }
              lineNumber++;
              tokenLineStartOffset = pos;
            }
          }
          if (!commentClosed) {
            pos++;
            scanError = 1;
          }
          value = text.substring(start, pos);
          return token = 13;
        }
        value += String.fromCharCode(code);
        pos++;
        return token = 16;
      case 45:
        value += String.fromCharCode(code);
        pos++;
        if (pos === len || !isDigit(text.charCodeAt(pos))) {
          return token = 16;
        }
      case 48:
      case 49:
      case 50:
      case 51:
      case 52:
      case 53:
      case 54:
      case 55:
      case 56:
      case 57:
        value += scanNumber();
        return token = 11;
      default:
        while (pos < len && isUnknownContentCharacter(code)) {
          pos++;
          code = text.charCodeAt(pos);
        }
        if (tokenOffset !== pos) {
          value = text.substring(tokenOffset, pos);
          switch (value) {
            case "true":
              return token = 8;
            case "false":
              return token = 9;
            case "null":
              return token = 7;
          }
          return token = 16;
        }
        value += String.fromCharCode(code);
        pos++;
        return token = 16;
    }
  }
  function isUnknownContentCharacter(code) {
    if (isWhiteSpace(code) || isLineBreak(code)) {
      return false;
    }
    switch (code) {
      case 125:
      case 93:
      case 123:
      case 91:
      case 34:
      case 58:
      case 44:
      case 47:
        return false;
    }
    return true;
  }
  function scanNextNonTrivia() {
    let result;
    do {
      result = scanNext();
    } while (result >= 12 && result <= 15);
    return result;
  }
  return {
    setPosition,
    getPosition: () => pos,
    scan: ignoreTrivia ? scanNextNonTrivia : scanNext,
    getToken: () => token,
    getTokenValue: () => value,
    getTokenOffset: () => tokenOffset,
    getTokenLength: () => pos - tokenOffset,
    getTokenStartLine: () => lineStartOffset,
    getTokenStartCharacter: () => tokenOffset - prevTokenLineStartOffset,
    getTokenError: () => scanError
  };
}
function isWhiteSpace(ch) {
  return ch === 32 || ch === 9;
}
function isLineBreak(ch) {
  return ch === 10 || ch === 13;
}
function isDigit(ch) {
  return ch >= 48 && ch <= 57;
}
var CharacterCodes;
(function(CharacterCodes2) {
  CharacterCodes2[CharacterCodes2["lineFeed"] = 10] = "lineFeed";
  CharacterCodes2[CharacterCodes2["carriageReturn"] = 13] = "carriageReturn";
  CharacterCodes2[CharacterCodes2["space"] = 32] = "space";
  CharacterCodes2[CharacterCodes2["_0"] = 48] = "_0";
  CharacterCodes2[CharacterCodes2["_1"] = 49] = "_1";
  CharacterCodes2[CharacterCodes2["_2"] = 50] = "_2";
  CharacterCodes2[CharacterCodes2["_3"] = 51] = "_3";
  CharacterCodes2[CharacterCodes2["_4"] = 52] = "_4";
  CharacterCodes2[CharacterCodes2["_5"] = 53] = "_5";
  CharacterCodes2[CharacterCodes2["_6"] = 54] = "_6";
  CharacterCodes2[CharacterCodes2["_7"] = 55] = "_7";
  CharacterCodes2[CharacterCodes2["_8"] = 56] = "_8";
  CharacterCodes2[CharacterCodes2["_9"] = 57] = "_9";
  CharacterCodes2[CharacterCodes2["a"] = 97] = "a";
  CharacterCodes2[CharacterCodes2["b"] = 98] = "b";
  CharacterCodes2[CharacterCodes2["c"] = 99] = "c";
  CharacterCodes2[CharacterCodes2["d"] = 100] = "d";
  CharacterCodes2[CharacterCodes2["e"] = 101] = "e";
  CharacterCodes2[CharacterCodes2["f"] = 102] = "f";
  CharacterCodes2[CharacterCodes2["g"] = 103] = "g";
  CharacterCodes2[CharacterCodes2["h"] = 104] = "h";
  CharacterCodes2[CharacterCodes2["i"] = 105] = "i";
  CharacterCodes2[CharacterCodes2["j"] = 106] = "j";
  CharacterCodes2[CharacterCodes2["k"] = 107] = "k";
  CharacterCodes2[CharacterCodes2["l"] = 108] = "l";
  CharacterCodes2[CharacterCodes2["m"] = 109] = "m";
  CharacterCodes2[CharacterCodes2["n"] = 110] = "n";
  CharacterCodes2[CharacterCodes2["o"] = 111] = "o";
  CharacterCodes2[CharacterCodes2["p"] = 112] = "p";
  CharacterCodes2[CharacterCodes2["q"] = 113] = "q";
  CharacterCodes2[CharacterCodes2["r"] = 114] = "r";
  CharacterCodes2[CharacterCodes2["s"] = 115] = "s";
  CharacterCodes2[CharacterCodes2["t"] = 116] = "t";
  CharacterCodes2[CharacterCodes2["u"] = 117] = "u";
  CharacterCodes2[CharacterCodes2["v"] = 118] = "v";
  CharacterCodes2[CharacterCodes2["w"] = 119] = "w";
  CharacterCodes2[CharacterCodes2["x"] = 120] = "x";
  CharacterCodes2[CharacterCodes2["y"] = 121] = "y";
  CharacterCodes2[CharacterCodes2["z"] = 122] = "z";
  CharacterCodes2[CharacterCodes2["A"] = 65] = "A";
  CharacterCodes2[CharacterCodes2["B"] = 66] = "B";
  CharacterCodes2[CharacterCodes2["C"] = 67] = "C";
  CharacterCodes2[CharacterCodes2["D"] = 68] = "D";
  CharacterCodes2[CharacterCodes2["E"] = 69] = "E";
  CharacterCodes2[CharacterCodes2["F"] = 70] = "F";
  CharacterCodes2[CharacterCodes2["G"] = 71] = "G";
  CharacterCodes2[CharacterCodes2["H"] = 72] = "H";
  CharacterCodes2[CharacterCodes2["I"] = 73] = "I";
  CharacterCodes2[CharacterCodes2["J"] = 74] = "J";
  CharacterCodes2[CharacterCodes2["K"] = 75] = "K";
  CharacterCodes2[CharacterCodes2["L"] = 76] = "L";
  CharacterCodes2[CharacterCodes2["M"] = 77] = "M";
  CharacterCodes2[CharacterCodes2["N"] = 78] = "N";
  CharacterCodes2[CharacterCodes2["O"] = 79] = "O";
  CharacterCodes2[CharacterCodes2["P"] = 80] = "P";
  CharacterCodes2[CharacterCodes2["Q"] = 81] = "Q";
  CharacterCodes2[CharacterCodes2["R"] = 82] = "R";
  CharacterCodes2[CharacterCodes2["S"] = 83] = "S";
  CharacterCodes2[CharacterCodes2["T"] = 84] = "T";
  CharacterCodes2[CharacterCodes2["U"] = 85] = "U";
  CharacterCodes2[CharacterCodes2["V"] = 86] = "V";
  CharacterCodes2[CharacterCodes2["W"] = 87] = "W";
  CharacterCodes2[CharacterCodes2["X"] = 88] = "X";
  CharacterCodes2[CharacterCodes2["Y"] = 89] = "Y";
  CharacterCodes2[CharacterCodes2["Z"] = 90] = "Z";
  CharacterCodes2[CharacterCodes2["asterisk"] = 42] = "asterisk";
  CharacterCodes2[CharacterCodes2["backslash"] = 92] = "backslash";
  CharacterCodes2[CharacterCodes2["closeBrace"] = 125] = "closeBrace";
  CharacterCodes2[CharacterCodes2["closeBracket"] = 93] = "closeBracket";
  CharacterCodes2[CharacterCodes2["colon"] = 58] = "colon";
  CharacterCodes2[CharacterCodes2["comma"] = 44] = "comma";
  CharacterCodes2[CharacterCodes2["dot"] = 46] = "dot";
  CharacterCodes2[CharacterCodes2["doubleQuote"] = 34] = "doubleQuote";
  CharacterCodes2[CharacterCodes2["minus"] = 45] = "minus";
  CharacterCodes2[CharacterCodes2["openBrace"] = 123] = "openBrace";
  CharacterCodes2[CharacterCodes2["openBracket"] = 91] = "openBracket";
  CharacterCodes2[CharacterCodes2["plus"] = 43] = "plus";
  CharacterCodes2[CharacterCodes2["slash"] = 47] = "slash";
  CharacterCodes2[CharacterCodes2["formFeed"] = 12] = "formFeed";
  CharacterCodes2[CharacterCodes2["tab"] = 9] = "tab";
})(CharacterCodes || (CharacterCodes = {}));

// node_modules/jsonc-parser/lib/esm/impl/string-intern.js
var cachedSpaces = new Array(20).fill(0).map((_, index) => {
  return " ".repeat(index);
});
var maxCachedValues = 200;
var cachedBreakLinesWithSpaces = {
  " ": {
    "\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return `
` + " ".repeat(index);
    }),
    "\r": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\r" + " ".repeat(index);
    }),
    "\r\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return `\r
` + " ".repeat(index);
    })
  },
  "\t": {
    "\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return `
` + "\t".repeat(index);
    }),
    "\r": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\r" + "\t".repeat(index);
    }),
    "\r\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return `\r
` + "\t".repeat(index);
    })
  }
};
var supportedEols = [`
`, "\r", `\r
`];

// node_modules/jsonc-parser/lib/esm/impl/format.js
function format(documentText, range, options) {
  let initialIndentLevel;
  let formatText;
  let formatTextStart;
  let rangeStart;
  let rangeEnd;
  if (range) {
    rangeStart = range.offset;
    rangeEnd = rangeStart + range.length;
    formatTextStart = rangeStart;
    while (formatTextStart > 0 && !isEOL(documentText, formatTextStart - 1)) {
      formatTextStart--;
    }
    let endOffset = rangeEnd;
    while (endOffset < documentText.length && !isEOL(documentText, endOffset)) {
      endOffset++;
    }
    formatText = documentText.substring(formatTextStart, endOffset);
    initialIndentLevel = computeIndentLevel(formatText, options);
  } else {
    formatText = documentText;
    initialIndentLevel = 0;
    formatTextStart = 0;
    rangeStart = 0;
    rangeEnd = documentText.length;
  }
  const eol = getEOL(options, documentText);
  const eolFastPathSupported = supportedEols.includes(eol);
  let numberLineBreaks = 0;
  let indentLevel = 0;
  let indentValue;
  if (options.insertSpaces) {
    indentValue = cachedSpaces[options.tabSize || 4] ?? repeat(cachedSpaces[1], options.tabSize || 4);
  } else {
    indentValue = "\t";
  }
  const indentType = indentValue === "\t" ? "\t" : " ";
  let scanner = createScanner(formatText, false);
  let hasError = false;
  function newLinesAndIndent() {
    if (numberLineBreaks > 1) {
      return repeat(eol, numberLineBreaks) + repeat(indentValue, initialIndentLevel + indentLevel);
    }
    const amountOfSpaces = indentValue.length * (initialIndentLevel + indentLevel);
    if (!eolFastPathSupported || amountOfSpaces > cachedBreakLinesWithSpaces[indentType][eol].length) {
      return eol + repeat(indentValue, initialIndentLevel + indentLevel);
    }
    if (amountOfSpaces <= 0) {
      return eol;
    }
    return cachedBreakLinesWithSpaces[indentType][eol][amountOfSpaces];
  }
  function scanNext() {
    let token = scanner.scan();
    numberLineBreaks = 0;
    while (token === 15 || token === 14) {
      if (token === 14 && options.keepLines) {
        numberLineBreaks += 1;
      } else if (token === 14) {
        numberLineBreaks = 1;
      }
      token = scanner.scan();
    }
    hasError = token === 16 || scanner.getTokenError() !== 0;
    return token;
  }
  const editOperations = [];
  function addEdit(text, startOffset, endOffset) {
    if (!hasError && (!range || startOffset < rangeEnd && endOffset > rangeStart) && documentText.substring(startOffset, endOffset) !== text) {
      editOperations.push({ offset: startOffset, length: endOffset - startOffset, content: text });
    }
  }
  let firstToken = scanNext();
  if (options.keepLines && numberLineBreaks > 0) {
    addEdit(repeat(eol, numberLineBreaks), 0, 0);
  }
  if (firstToken !== 17) {
    let firstTokenStart = scanner.getTokenOffset() + formatTextStart;
    let initialIndent = indentValue.length * initialIndentLevel < 20 && options.insertSpaces ? cachedSpaces[indentValue.length * initialIndentLevel] : repeat(indentValue, initialIndentLevel);
    addEdit(initialIndent, formatTextStart, firstTokenStart);
  }
  while (firstToken !== 17) {
    let firstTokenEnd = scanner.getTokenOffset() + scanner.getTokenLength() + formatTextStart;
    let secondToken = scanNext();
    let replaceContent = "";
    let needsLineBreak = false;
    while (numberLineBreaks === 0 && (secondToken === 12 || secondToken === 13)) {
      let commentTokenStart = scanner.getTokenOffset() + formatTextStart;
      addEdit(cachedSpaces[1], firstTokenEnd, commentTokenStart);
      firstTokenEnd = scanner.getTokenOffset() + scanner.getTokenLength() + formatTextStart;
      needsLineBreak = secondToken === 12;
      replaceContent = needsLineBreak ? newLinesAndIndent() : "";
      secondToken = scanNext();
    }
    if (secondToken === 2) {
      if (firstToken !== 1) {
        indentLevel--;
      }
      if (options.keepLines && numberLineBreaks > 0 || !options.keepLines && firstToken !== 1) {
        replaceContent = newLinesAndIndent();
      } else if (options.keepLines) {
        replaceContent = cachedSpaces[1];
      }
    } else if (secondToken === 4) {
      if (firstToken !== 3) {
        indentLevel--;
      }
      if (options.keepLines && numberLineBreaks > 0 || !options.keepLines && firstToken !== 3) {
        replaceContent = newLinesAndIndent();
      } else if (options.keepLines) {
        replaceContent = cachedSpaces[1];
      }
    } else {
      switch (firstToken) {
        case 3:
        case 1:
          indentLevel++;
          if (options.keepLines && numberLineBreaks > 0 || !options.keepLines) {
            replaceContent = newLinesAndIndent();
          } else {
            replaceContent = cachedSpaces[1];
          }
          break;
        case 5:
          if (options.keepLines && numberLineBreaks > 0 || !options.keepLines) {
            replaceContent = newLinesAndIndent();
          } else {
            replaceContent = cachedSpaces[1];
          }
          break;
        case 12:
          replaceContent = newLinesAndIndent();
          break;
        case 13:
          if (numberLineBreaks > 0) {
            replaceContent = newLinesAndIndent();
          } else if (!needsLineBreak) {
            replaceContent = cachedSpaces[1];
          }
          break;
        case 6:
          if (options.keepLines && numberLineBreaks > 0) {
            replaceContent = newLinesAndIndent();
          } else if (!needsLineBreak) {
            replaceContent = cachedSpaces[1];
          }
          break;
        case 10:
          if (options.keepLines && numberLineBreaks > 0) {
            replaceContent = newLinesAndIndent();
          } else if (secondToken === 6 && !needsLineBreak) {
            replaceContent = "";
          }
          break;
        case 7:
        case 8:
        case 9:
        case 11:
        case 2:
        case 4:
          if (options.keepLines && numberLineBreaks > 0) {
            replaceContent = newLinesAndIndent();
          } else {
            if ((secondToken === 12 || secondToken === 13) && !needsLineBreak) {
              replaceContent = cachedSpaces[1];
            } else if (secondToken !== 5 && secondToken !== 17) {
              hasError = true;
            }
          }
          break;
        case 16:
          hasError = true;
          break;
      }
      if (numberLineBreaks > 0 && (secondToken === 12 || secondToken === 13)) {
        replaceContent = newLinesAndIndent();
      }
    }
    if (secondToken === 17) {
      if (options.keepLines && numberLineBreaks > 0) {
        replaceContent = newLinesAndIndent();
      } else {
        replaceContent = options.insertFinalNewline ? eol : "";
      }
    }
    const secondTokenStart = scanner.getTokenOffset() + formatTextStart;
    addEdit(replaceContent, firstTokenEnd, secondTokenStart);
    firstToken = secondToken;
  }
  return editOperations;
}
function repeat(s, count) {
  let result = "";
  for (let i = 0;i < count; i++) {
    result += s;
  }
  return result;
}
function computeIndentLevel(content, options) {
  let i = 0;
  let nChars = 0;
  const tabSize = options.tabSize || 4;
  while (i < content.length) {
    let ch = content.charAt(i);
    if (ch === cachedSpaces[1]) {
      nChars++;
    } else if (ch === "\t") {
      nChars += tabSize;
    } else {
      break;
    }
    i++;
  }
  return Math.floor(nChars / tabSize);
}
function getEOL(options, text) {
  for (let i = 0;i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === "\r") {
      if (i + 1 < text.length && text.charAt(i + 1) === `
`) {
        return `\r
`;
      }
      return "\r";
    } else if (ch === `
`) {
      return `
`;
    }
  }
  return options && options.eol || `
`;
}
function isEOL(text, offset) {
  return `\r
`.indexOf(text.charAt(offset)) !== -1;
}

// node_modules/jsonc-parser/lib/esm/impl/parser.js
var ParseOptions;
(function(ParseOptions2) {
  ParseOptions2.DEFAULT = {
    allowTrailingComma: false
  };
})(ParseOptions || (ParseOptions = {}));
function parse(text, errors = [], options = ParseOptions.DEFAULT) {
  let currentProperty = null;
  let currentParent = [];
  const previousParents = [];
  function onValue(value) {
    if (Array.isArray(currentParent)) {
      currentParent.push(value);
    } else if (currentProperty !== null) {
      currentParent[currentProperty] = value;
    }
  }
  const visitor = {
    onObjectBegin: () => {
      const object = {};
      onValue(object);
      previousParents.push(currentParent);
      currentParent = object;
      currentProperty = null;
    },
    onObjectProperty: (name) => {
      currentProperty = name;
    },
    onObjectEnd: () => {
      currentParent = previousParents.pop();
    },
    onArrayBegin: () => {
      const array = [];
      onValue(array);
      previousParents.push(currentParent);
      currentParent = array;
      currentProperty = null;
    },
    onArrayEnd: () => {
      currentParent = previousParents.pop();
    },
    onLiteralValue: onValue,
    onError: (error, offset, length) => {
      errors.push({ error, offset, length });
    }
  };
  visit(text, visitor, options);
  return currentParent[0];
}
function parseTree(text, errors = [], options = ParseOptions.DEFAULT) {
  let currentParent = { type: "array", offset: -1, length: -1, children: [], parent: undefined };
  function ensurePropertyComplete(endOffset) {
    if (currentParent.type === "property") {
      currentParent.length = endOffset - currentParent.offset;
      currentParent = currentParent.parent;
    }
  }
  function onValue(valueNode) {
    currentParent.children.push(valueNode);
    return valueNode;
  }
  const visitor = {
    onObjectBegin: (offset) => {
      currentParent = onValue({ type: "object", offset, length: -1, parent: currentParent, children: [] });
    },
    onObjectProperty: (name, offset, length) => {
      currentParent = onValue({ type: "property", offset, length: -1, parent: currentParent, children: [] });
      currentParent.children.push({ type: "string", value: name, offset, length, parent: currentParent });
    },
    onObjectEnd: (offset, length) => {
      ensurePropertyComplete(offset + length);
      currentParent.length = offset + length - currentParent.offset;
      currentParent = currentParent.parent;
      ensurePropertyComplete(offset + length);
    },
    onArrayBegin: (offset, length) => {
      currentParent = onValue({ type: "array", offset, length: -1, parent: currentParent, children: [] });
    },
    onArrayEnd: (offset, length) => {
      currentParent.length = offset + length - currentParent.offset;
      currentParent = currentParent.parent;
      ensurePropertyComplete(offset + length);
    },
    onLiteralValue: (value, offset, length) => {
      onValue({ type: getNodeType(value), offset, length, parent: currentParent, value });
      ensurePropertyComplete(offset + length);
    },
    onSeparator: (sep, offset, length) => {
      if (currentParent.type === "property") {
        if (sep === ":") {
          currentParent.colonOffset = offset;
        } else if (sep === ",") {
          ensurePropertyComplete(offset);
        }
      }
    },
    onError: (error, offset, length) => {
      errors.push({ error, offset, length });
    }
  };
  visit(text, visitor, options);
  const result = currentParent.children[0];
  if (result) {
    delete result.parent;
  }
  return result;
}
function findNodeAtLocation(root, path) {
  if (!root) {
    return;
  }
  let node = root;
  for (let segment of path) {
    if (typeof segment === "string") {
      if (node.type !== "object" || !Array.isArray(node.children)) {
        return;
      }
      let found = false;
      for (const propertyNode of node.children) {
        if (Array.isArray(propertyNode.children) && propertyNode.children[0].value === segment && propertyNode.children.length === 2) {
          node = propertyNode.children[1];
          found = true;
          break;
        }
      }
      if (!found) {
        return;
      }
    } else {
      const index = segment;
      if (node.type !== "array" || index < 0 || !Array.isArray(node.children) || index >= node.children.length) {
        return;
      }
      node = node.children[index];
    }
  }
  return node;
}
function visit(text, visitor, options = ParseOptions.DEFAULT) {
  const _scanner = createScanner(text, false);
  const _jsonPath = [];
  let suppressedCallbacks = 0;
  function toNoArgVisit(visitFunction) {
    return visitFunction ? () => suppressedCallbacks === 0 && visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter()) : () => true;
  }
  function toOneArgVisit(visitFunction) {
    return visitFunction ? (arg) => suppressedCallbacks === 0 && visitFunction(arg, _scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter()) : () => true;
  }
  function toOneArgVisitWithPath(visitFunction) {
    return visitFunction ? (arg) => suppressedCallbacks === 0 && visitFunction(arg, _scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter(), () => _jsonPath.slice()) : () => true;
  }
  function toBeginVisit(visitFunction) {
    return visitFunction ? () => {
      if (suppressedCallbacks > 0) {
        suppressedCallbacks++;
      } else {
        let cbReturn = visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter(), () => _jsonPath.slice());
        if (cbReturn === false) {
          suppressedCallbacks = 1;
        }
      }
    } : () => true;
  }
  function toEndVisit(visitFunction) {
    return visitFunction ? () => {
      if (suppressedCallbacks > 0) {
        suppressedCallbacks--;
      }
      if (suppressedCallbacks === 0) {
        visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter());
      }
    } : () => true;
  }
  const onObjectBegin = toBeginVisit(visitor.onObjectBegin), onObjectProperty = toOneArgVisitWithPath(visitor.onObjectProperty), onObjectEnd = toEndVisit(visitor.onObjectEnd), onArrayBegin = toBeginVisit(visitor.onArrayBegin), onArrayEnd = toEndVisit(visitor.onArrayEnd), onLiteralValue = toOneArgVisitWithPath(visitor.onLiteralValue), onSeparator = toOneArgVisit(visitor.onSeparator), onComment = toNoArgVisit(visitor.onComment), onError = toOneArgVisit(visitor.onError);
  const disallowComments = options && options.disallowComments;
  const allowTrailingComma = options && options.allowTrailingComma;
  function scanNext() {
    while (true) {
      const token = _scanner.scan();
      switch (_scanner.getTokenError()) {
        case 4:
          handleError(14);
          break;
        case 5:
          handleError(15);
          break;
        case 3:
          handleError(13);
          break;
        case 1:
          if (!disallowComments) {
            handleError(11);
          }
          break;
        case 2:
          handleError(12);
          break;
        case 6:
          handleError(16);
          break;
      }
      switch (token) {
        case 12:
        case 13:
          if (disallowComments) {
            handleError(10);
          } else {
            onComment();
          }
          break;
        case 16:
          handleError(1);
          break;
        case 15:
        case 14:
          break;
        default:
          return token;
      }
    }
  }
  function handleError(error, skipUntilAfter = [], skipUntil = []) {
    onError(error);
    if (skipUntilAfter.length + skipUntil.length > 0) {
      let token = _scanner.getToken();
      while (token !== 17) {
        if (skipUntilAfter.indexOf(token) !== -1) {
          scanNext();
          break;
        } else if (skipUntil.indexOf(token) !== -1) {
          break;
        }
        token = scanNext();
      }
    }
  }
  function parseString(isValue) {
    const value = _scanner.getTokenValue();
    if (isValue) {
      onLiteralValue(value);
    } else {
      onObjectProperty(value);
      _jsonPath.push(value);
    }
    scanNext();
    return true;
  }
  function parseLiteral() {
    switch (_scanner.getToken()) {
      case 11:
        const tokenValue = _scanner.getTokenValue();
        let value = Number(tokenValue);
        if (isNaN(value)) {
          handleError(2);
          value = 0;
        }
        onLiteralValue(value);
        break;
      case 7:
        onLiteralValue(null);
        break;
      case 8:
        onLiteralValue(true);
        break;
      case 9:
        onLiteralValue(false);
        break;
      default:
        return false;
    }
    scanNext();
    return true;
  }
  function parseProperty() {
    if (_scanner.getToken() !== 10) {
      handleError(3, [], [2, 5]);
      return false;
    }
    parseString(false);
    if (_scanner.getToken() === 6) {
      onSeparator(":");
      scanNext();
      if (!parseValue()) {
        handleError(4, [], [2, 5]);
      }
    } else {
      handleError(5, [], [2, 5]);
    }
    _jsonPath.pop();
    return true;
  }
  function parseObject() {
    onObjectBegin();
    scanNext();
    let needsComma = false;
    while (_scanner.getToken() !== 2 && _scanner.getToken() !== 17) {
      if (_scanner.getToken() === 5) {
        if (!needsComma) {
          handleError(4, [], []);
        }
        onSeparator(",");
        scanNext();
        if (_scanner.getToken() === 2 && allowTrailingComma) {
          break;
        }
      } else if (needsComma) {
        handleError(6, [], []);
      }
      if (!parseProperty()) {
        handleError(4, [], [2, 5]);
      }
      needsComma = true;
    }
    onObjectEnd();
    if (_scanner.getToken() !== 2) {
      handleError(7, [2], []);
    } else {
      scanNext();
    }
    return true;
  }
  function parseArray() {
    onArrayBegin();
    scanNext();
    let isFirstElement = true;
    let needsComma = false;
    while (_scanner.getToken() !== 4 && _scanner.getToken() !== 17) {
      if (_scanner.getToken() === 5) {
        if (!needsComma) {
          handleError(4, [], []);
        }
        onSeparator(",");
        scanNext();
        if (_scanner.getToken() === 4 && allowTrailingComma) {
          break;
        }
      } else if (needsComma) {
        handleError(6, [], []);
      }
      if (isFirstElement) {
        _jsonPath.push(0);
        isFirstElement = false;
      } else {
        _jsonPath[_jsonPath.length - 1]++;
      }
      if (!parseValue()) {
        handleError(4, [], [4, 5]);
      }
      needsComma = true;
    }
    onArrayEnd();
    if (!isFirstElement) {
      _jsonPath.pop();
    }
    if (_scanner.getToken() !== 4) {
      handleError(8, [4], []);
    } else {
      scanNext();
    }
    return true;
  }
  function parseValue() {
    switch (_scanner.getToken()) {
      case 3:
        return parseArray();
      case 1:
        return parseObject();
      case 10:
        return parseString(true);
      default:
        return parseLiteral();
    }
  }
  scanNext();
  if (_scanner.getToken() === 17) {
    if (options.allowEmptyContent) {
      return true;
    }
    handleError(4, [], []);
    return false;
  }
  if (!parseValue()) {
    handleError(4, [], []);
    return false;
  }
  if (_scanner.getToken() !== 17) {
    handleError(9, [], []);
  }
  return true;
}
function getNodeType(value) {
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return "string";
    case "object": {
      if (!value) {
        return "null";
      } else if (Array.isArray(value)) {
        return "array";
      }
      return "object";
    }
    default:
      return "null";
  }
}

// node_modules/jsonc-parser/lib/esm/impl/edit.js
function setProperty(text, originalPath, value, options) {
  const path = originalPath.slice();
  const errors = [];
  const root = parseTree(text, errors);
  let parent = undefined;
  let lastSegment = undefined;
  while (path.length > 0) {
    lastSegment = path.pop();
    parent = findNodeAtLocation(root, path);
    if (parent === undefined && value !== undefined) {
      if (typeof lastSegment === "string") {
        value = { [lastSegment]: value };
      } else {
        value = [value];
      }
    } else {
      break;
    }
  }
  if (!parent) {
    if (value === undefined) {
      throw new Error("Can not delete in empty document");
    }
    return withFormatting(text, { offset: root ? root.offset : 0, length: root ? root.length : 0, content: JSON.stringify(value) }, options);
  } else if (parent.type === "object" && typeof lastSegment === "string" && Array.isArray(parent.children)) {
    const existing = findNodeAtLocation(parent, [lastSegment]);
    if (existing !== undefined) {
      if (value === undefined) {
        if (!existing.parent) {
          throw new Error("Malformed AST");
        }
        const propertyIndex = parent.children.indexOf(existing.parent);
        let removeBegin;
        let removeEnd = existing.parent.offset + existing.parent.length;
        if (propertyIndex > 0) {
          let previous = parent.children[propertyIndex - 1];
          removeBegin = previous.offset + previous.length;
        } else {
          removeBegin = parent.offset + 1;
          if (parent.children.length > 1) {
            let next = parent.children[1];
            removeEnd = next.offset;
          }
        }
        return withFormatting(text, { offset: removeBegin, length: removeEnd - removeBegin, content: "" }, options);
      } else {
        return withFormatting(text, { offset: existing.offset, length: existing.length, content: JSON.stringify(value) }, options);
      }
    } else {
      if (value === undefined) {
        return [];
      }
      const newProperty = `${JSON.stringify(lastSegment)}: ${JSON.stringify(value)}`;
      const index = options.getInsertionIndex ? options.getInsertionIndex(parent.children.map((p) => p.children[0].value)) : parent.children.length;
      let edit;
      if (index > 0) {
        let previous = parent.children[index - 1];
        edit = { offset: previous.offset + previous.length, length: 0, content: "," + newProperty };
      } else if (parent.children.length === 0) {
        edit = { offset: parent.offset + 1, length: 0, content: newProperty };
      } else {
        edit = { offset: parent.offset + 1, length: 0, content: newProperty + "," };
      }
      return withFormatting(text, edit, options);
    }
  } else if (parent.type === "array" && typeof lastSegment === "number" && Array.isArray(parent.children)) {
    const insertIndex = lastSegment;
    if (insertIndex === -1) {
      const newProperty = `${JSON.stringify(value)}`;
      let edit;
      if (parent.children.length === 0) {
        edit = { offset: parent.offset + 1, length: 0, content: newProperty };
      } else {
        const previous = parent.children[parent.children.length - 1];
        edit = { offset: previous.offset + previous.length, length: 0, content: "," + newProperty };
      }
      return withFormatting(text, edit, options);
    } else if (value === undefined && parent.children.length >= 0) {
      const removalIndex = lastSegment;
      const toRemove = parent.children[removalIndex];
      let edit;
      if (parent.children.length === 1) {
        edit = { offset: parent.offset + 1, length: parent.length - 2, content: "" };
      } else if (parent.children.length - 1 === removalIndex) {
        let previous = parent.children[removalIndex - 1];
        let offset = previous.offset + previous.length;
        let parentEndOffset = parent.offset + parent.length;
        edit = { offset, length: parentEndOffset - 2 - offset, content: "" };
      } else {
        edit = { offset: toRemove.offset, length: parent.children[removalIndex + 1].offset - toRemove.offset, content: "" };
      }
      return withFormatting(text, edit, options);
    } else if (value !== undefined) {
      let edit;
      const newProperty = `${JSON.stringify(value)}`;
      if (!options.isArrayInsertion && parent.children.length > lastSegment) {
        const toModify = parent.children[lastSegment];
        edit = { offset: toModify.offset, length: toModify.length, content: newProperty };
      } else if (parent.children.length === 0 || lastSegment === 0) {
        edit = { offset: parent.offset + 1, length: 0, content: parent.children.length === 0 ? newProperty : newProperty + "," };
      } else {
        const index = lastSegment > parent.children.length ? parent.children.length : lastSegment;
        const previous = parent.children[index - 1];
        edit = { offset: previous.offset + previous.length, length: 0, content: "," + newProperty };
      }
      return withFormatting(text, edit, options);
    } else {
      throw new Error(`Can not ${value === undefined ? "remove" : options.isArrayInsertion ? "insert" : "modify"} Array index ${insertIndex} as length is not sufficient`);
    }
  } else {
    throw new Error(`Can not add ${typeof lastSegment !== "number" ? "index" : "property"} to parent of type ${parent.type}`);
  }
}
function withFormatting(text, edit, options) {
  if (!options.formattingOptions) {
    return [edit];
  }
  let newText = applyEdit(text, edit);
  let begin = edit.offset;
  let end = edit.offset + edit.content.length;
  if (edit.length === 0 || edit.content.length === 0) {
    while (begin > 0 && !isEOL(newText, begin - 1)) {
      begin--;
    }
    while (end < newText.length && !isEOL(newText, end)) {
      end++;
    }
  }
  const edits = format(newText, { offset: begin, length: end - begin }, { ...options.formattingOptions, keepLines: false });
  for (let i = edits.length - 1;i >= 0; i--) {
    const edit2 = edits[i];
    newText = applyEdit(newText, edit2);
    begin = Math.min(begin, edit2.offset);
    end = Math.max(end, edit2.offset + edit2.length);
    end += edit2.content.length - edit2.length;
  }
  const editLength = text.length - (newText.length - end) - begin;
  return [{ offset: begin, length: editLength, content: newText.substring(begin, end) }];
}
function applyEdit(text, edit) {
  return text.substring(0, edit.offset) + edit.content + text.substring(edit.offset + edit.length);
}

// node_modules/jsonc-parser/lib/esm/main.js
var ScanError;
(function(ScanError2) {
  ScanError2[ScanError2["None"] = 0] = "None";
  ScanError2[ScanError2["UnexpectedEndOfComment"] = 1] = "UnexpectedEndOfComment";
  ScanError2[ScanError2["UnexpectedEndOfString"] = 2] = "UnexpectedEndOfString";
  ScanError2[ScanError2["UnexpectedEndOfNumber"] = 3] = "UnexpectedEndOfNumber";
  ScanError2[ScanError2["InvalidUnicode"] = 4] = "InvalidUnicode";
  ScanError2[ScanError2["InvalidEscapeCharacter"] = 5] = "InvalidEscapeCharacter";
  ScanError2[ScanError2["InvalidCharacter"] = 6] = "InvalidCharacter";
})(ScanError || (ScanError = {}));
var SyntaxKind;
(function(SyntaxKind2) {
  SyntaxKind2[SyntaxKind2["OpenBraceToken"] = 1] = "OpenBraceToken";
  SyntaxKind2[SyntaxKind2["CloseBraceToken"] = 2] = "CloseBraceToken";
  SyntaxKind2[SyntaxKind2["OpenBracketToken"] = 3] = "OpenBracketToken";
  SyntaxKind2[SyntaxKind2["CloseBracketToken"] = 4] = "CloseBracketToken";
  SyntaxKind2[SyntaxKind2["CommaToken"] = 5] = "CommaToken";
  SyntaxKind2[SyntaxKind2["ColonToken"] = 6] = "ColonToken";
  SyntaxKind2[SyntaxKind2["NullKeyword"] = 7] = "NullKeyword";
  SyntaxKind2[SyntaxKind2["TrueKeyword"] = 8] = "TrueKeyword";
  SyntaxKind2[SyntaxKind2["FalseKeyword"] = 9] = "FalseKeyword";
  SyntaxKind2[SyntaxKind2["StringLiteral"] = 10] = "StringLiteral";
  SyntaxKind2[SyntaxKind2["NumericLiteral"] = 11] = "NumericLiteral";
  SyntaxKind2[SyntaxKind2["LineCommentTrivia"] = 12] = "LineCommentTrivia";
  SyntaxKind2[SyntaxKind2["BlockCommentTrivia"] = 13] = "BlockCommentTrivia";
  SyntaxKind2[SyntaxKind2["LineBreakTrivia"] = 14] = "LineBreakTrivia";
  SyntaxKind2[SyntaxKind2["Trivia"] = 15] = "Trivia";
  SyntaxKind2[SyntaxKind2["Unknown"] = 16] = "Unknown";
  SyntaxKind2[SyntaxKind2["EOF"] = 17] = "EOF";
})(SyntaxKind || (SyntaxKind = {}));
var parse2 = parse;
var ParseErrorCode;
(function(ParseErrorCode2) {
  ParseErrorCode2[ParseErrorCode2["InvalidSymbol"] = 1] = "InvalidSymbol";
  ParseErrorCode2[ParseErrorCode2["InvalidNumberFormat"] = 2] = "InvalidNumberFormat";
  ParseErrorCode2[ParseErrorCode2["PropertyNameExpected"] = 3] = "PropertyNameExpected";
  ParseErrorCode2[ParseErrorCode2["ValueExpected"] = 4] = "ValueExpected";
  ParseErrorCode2[ParseErrorCode2["ColonExpected"] = 5] = "ColonExpected";
  ParseErrorCode2[ParseErrorCode2["CommaExpected"] = 6] = "CommaExpected";
  ParseErrorCode2[ParseErrorCode2["CloseBraceExpected"] = 7] = "CloseBraceExpected";
  ParseErrorCode2[ParseErrorCode2["CloseBracketExpected"] = 8] = "CloseBracketExpected";
  ParseErrorCode2[ParseErrorCode2["EndOfFileExpected"] = 9] = "EndOfFileExpected";
  ParseErrorCode2[ParseErrorCode2["InvalidCommentToken"] = 10] = "InvalidCommentToken";
  ParseErrorCode2[ParseErrorCode2["UnexpectedEndOfComment"] = 11] = "UnexpectedEndOfComment";
  ParseErrorCode2[ParseErrorCode2["UnexpectedEndOfString"] = 12] = "UnexpectedEndOfString";
  ParseErrorCode2[ParseErrorCode2["UnexpectedEndOfNumber"] = 13] = "UnexpectedEndOfNumber";
  ParseErrorCode2[ParseErrorCode2["InvalidUnicode"] = 14] = "InvalidUnicode";
  ParseErrorCode2[ParseErrorCode2["InvalidEscapeCharacter"] = 15] = "InvalidEscapeCharacter";
  ParseErrorCode2[ParseErrorCode2["InvalidCharacter"] = 16] = "InvalidCharacter";
})(ParseErrorCode || (ParseErrorCode = {}));
function modify(text, path, value, options) {
  return setProperty(text, path, value, options);
}
function applyEdits(text, edits) {
  let sortedEdits = edits.slice(0).sort((a, b) => {
    const diff = a.offset - b.offset;
    if (diff === 0) {
      return a.length - b.length;
    }
    return diff;
  });
  let lastModifiedOffset = text.length;
  for (let i = sortedEdits.length - 1;i >= 0; i--) {
    let e = sortedEdits[i];
    if (e.offset + e.length <= lastModifiedOffset) {
      text = applyEdit(text, e);
    } else {
      throw new Error("Overlapping edit");
    }
    lastModifiedOffset = e.offset;
  }
  return text;
}

// service/core.ts
var REPO = "jasonxu114514/opencode2api";
function parseConfig(text) {
  const errors = [];
  const data = parse2(text, errors, { allowTrailingComma: true });
  if (errors.length || !data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Configuration is not a valid JSON object.");
  return data;
}
function edit(text, path, value) {
  return applyEdits(text, modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
}
function newer(latest, current) {
  const version = (s) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(s)?.slice(1).map(Number);
  const a = version(latest), b = version(current);
  return !!a && !!b && a.some((v, i) => v > b[i] && a.slice(0, i).every((x, j) => x === b[j]));
}
function assetName(platform, arch, tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag))
    throw new Error("Only stable version tags are supported.");
  if (!["darwin", "win32", "linux"].includes(platform) || !["arm64", "x64"].includes(arch))
    throw new Error("Unsupported platform/architecture.");
  if (platform === "win32" && arch !== "x64")
    throw new Error("Windows ARM64 requires an x64 Node runtime (upstream publishes Windows x64).");
  return `opencode2api_${tag}_${platform === "win32" ? "windows" : platform}_${arch === "x64" ? "amd64" : "arm64"}.${platform === "win32" ? "zip" : "tar.gz"}`;
}
function mergeCatalog(text, rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 1e4)
    throw new Error("Empty or invalid catalog; existing models preserved.");
  const c = parseConfig(text);
  const key = c.providers?.opencode2api ? "providers" : c.provider?.opencode2api ? "provider" : null;
  if (!key)
    throw new Error("Add an opencode2api provider in OpenCode/OpenChamber first.");
  const p = c[key].opencode2api;
  const url = p.settings?.baseURL ?? p.options?.baseURL;
  if (url?.replace(/\/$/, "") !== "http://127.0.0.1:8080/v1")
    throw new Error("Only the local opencode2api provider at port 8080 is supported.");
  let result = text;
  const added = [];
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !row.id.trim())
      throw new Error("Invalid model entry; no changes saved.");
    const id = row.id, prior = p.models?.[id];
    if (prior && (prior.modelID ?? prior.id ?? id) !== id)
      continue;
    const m = structuredClone(prior ?? (key === "providers" ? { modelID: id, name: id } : { name: id }));
    if (!prior)
      added.push(id);
    for (const [source, dest] of [["context_window", "context"], ["max_input", "input"], ["max_output", "output"]]) {
      const n = row[source] ?? row.metadata?.[source];
      if (Number.isSafeInteger(n) && n > 0)
        (m.limit ??= {})[dest] = n;
    }
    const meta = row.metadata ?? {};
    if (key === "providers") {
      if (typeof meta.tool_call === "boolean")
        (m.capabilities ??= {}).tools = meta.tool_call;
      for (const [source, dest] of [["input_modalities", "input"], ["output_modalities", "output"]]) {
        const values = meta[source];
        if (Array.isArray(values) && values.length && values.every((x) => typeof x === "string"))
          (m.capabilities ??= {})[dest] = values;
      }
    } else {
      if (typeof meta.tool_call === "boolean")
        m.tool_call = meta.tool_call;
      for (const [source, dest] of [["input_modalities", "input"], ["output_modalities", "output"]]) {
        const values = meta[source];
        if (Array.isArray(values) && values.length && values.every((x) => typeof x === "string"))
          (m.modalities ??= {})[dest] = values;
      }
    }
    for (const [field, value] of Object.entries(m)) {
      if (JSON.stringify(prior?.[field]) !== JSON.stringify(value))
        result = edit(result, [key, "opencode2api", "models", id, field], value);
    }
  }
  return { text: result, added, count: Object.keys(parseConfig(result)[key].opencode2api.models).length };
}
function validateArchiveEntries(entries) {
  for (const name of entries) {
    if (!name || name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.replaceAll("\\", "/").split("/").includes(".."))
      throw new Error("Unsafe archive path.");
  }
}

// service/platform.ts
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, open } from "node:fs/promises";
import path from "node:path";
var exec = promisify(execFile);
async function command(file, args, env) {
  return (await exec(file, args, { timeout: 20000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, ...env } })).stdout.trim();
}
async function ps(script, env) {
  return command("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from('$ErrorActionPreference="Stop"; ' + script, "utf16le").toString("base64")], env);
}
async function discoverMacBinary(plist) {
  const data = JSON.parse(await command("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist]));
  return data.ProgramArguments?.[0] ?? data.Program;
}
async function processMatches(pid, binary) {
  if (!Number.isSafeInteger(pid) || pid < 2)
    return false;
  if (process.platform === "win32") {
    const found = await ps('$p=Get-CimInstance Win32_Process -Filter ("ProcessId="+$env:OC2_PID); if ($p -and $p.ExecutablePath -eq $env:OC2_BINARY) { "match" }', { OC2_PID: String(pid), OC2_BINARY: path.resolve(binary) });
    return found === "match";
  }
  try {
    return await command("/bin/ps", ["-p", String(pid), "-o", "comm="]) === path.resolve(binary);
  } catch {
    return false;
  }
}
async function control(action, s, state, log) {
  if (process.platform === "darwin" && s.launchLabel) {
    const label = `gui/${process.getuid()}/${s.launchLabel}`;
    const plist = path.join(process.env.HOME, "Library", "LaunchAgents", `${s.launchLabel}.plist`);
    if (action !== "start") {
      try {
        await command("/bin/launchctl", ["bootout", label]);
      } catch {
        if (action === "stop")
          throw new Error("Cannot stop this LaunchAgent; check the configured label.");
      }
    }
    if (action !== "stop") {
      try {
        await command("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, plist]);
      } catch {
        await command("/bin/launchctl", ["kickstart", label]);
      }
    }
    return;
  }
  const pidPath = path.join(state, "gateway-pid.json");
  let saved;
  try {
    saved = JSON.parse(await readFile(pidPath, "utf8"));
  } catch {}
  const matching = saved?.binary === s.binary && await processMatches(saved.pid, s.binary);
  if (action !== "start" && matching) {
    if (process.platform === "win32")
      await ps("Stop-Process -Id ([int]$env:OC2_PID)", { OC2_PID: String(saved.pid) });
    else
      process.kill(saved.pid, "SIGTERM");
    for (let i = 0;i < 30; i++) {
      if (!await processMatches(saved.pid, s.binary))
        break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (await processMatches(saved.pid, s.binary))
      throw new Error("Gateway is still shutting down; try again.");
  } else if (action === "stop" && !matching)
    throw new Error("This gateway was not started by the manager. Stop it in its original service manager.");
  if (action !== "stop" && !matching || action === "restart" && matching) {
    const alive = await fetch("http://127.0.0.1:8080/healthz", { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
    if (alive)
      throw new Error("Port 8080 is already in use. Stop the existing gateway first.");
    const fd = await open(log, "a", 384);
    try {
      const child = spawn(s.binary, ["-config", s.configPath], { cwd: path.dirname(s.configPath), detached: true, windowsHide: true, stdio: ["ignore", fd.fd, fd.fd] });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
      await writeFile(pidPath, JSON.stringify({ pid: child.pid, binary: s.binary }), { mode: 384 });
    } finally {
      await fd.close();
    }
  }
}

// service/manager.ts
var stateDir = process.env.OPENCODE2API_MANAGER_DATA_DIR ?? path2.join(os.homedir(), ".config", "opencode2api-manager");
async function atomic(file, text, original) {
  await mkdir(path2.dirname(file), { recursive: true, mode: 448 });
  if (original !== undefined && await readFile2(file, "utf8") !== original)
    throw new Error("File changed during this operation. Try again.");
  const temp = file + ".manager-" + randomBytes(6).toString("hex");
  try {
    await writeFile2(temp, text, { mode: 384, flag: "wx" });
    if (original !== undefined && await readFile2(file, "utf8") !== original)
      throw new Error("Concurrent edit detected.");
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}
async function settings() {
  const home = os.homedir(), legacy = path2.join(home, "Documents", "Codex", "Services", "opencode2api");
  const root = existsSync(path2.join(legacy, "config.json")) ? legacy : process.platform === "win32" ? path2.join(process.env.LOCALAPPDATA ?? path2.join(home, "AppData", "Local"), "opencode2api") : path2.join(home, ".local", "share", "opencode2api");
  const oc = path2.join(process.env.XDG_CONFIG_HOME ?? path2.join(home, ".config"), "opencode");
  let saved = {};
  try {
    saved = JSON.parse(await readFile2(path2.join(stateDir, "settings.json"), "utf8"));
  } catch {}
  const defaults = { root, binary: path2.join(root, process.platform === "win32" ? "opencode2api.exe" : "opencode2api"), configPath: path2.join(root, "config.json"), providerPath: path2.join(oc, existsSync(path2.join(oc, "opencode.jsonc")) ? "opencode.jsonc" : existsSync(path2.join(oc, "opencode.json")) ? "opencode.json" : "opencode.jsonc"), launchLabel: "", autoSync: false };
  if (process.platform === "darwin" && !saved.binary) {
    const agents = path2.join(home, "Library", "LaunchAgents");
    if (existsSync(agents)) {
      for (const name of await readdir(agents)) {
        if (!name.endsWith(".plist") || !name.includes("opencode2api") || name.includes("sync"))
          continue;
        try {
          const binary = await discoverMacBinary(path2.join(agents, name));
          if (typeof binary === "string" && path2.basename(binary) === "opencode2api") {
            defaults.binary = binary;
            defaults.launchLabel = name.slice(0, -6);
            break;
          }
        } catch {}
      }
    }
  }
  return { ...defaults, ...saved };
}
async function saveSettings(value) {
  const previous = await settings();
  const next = { ...previous };
  for (const key of ["root", "binary", "configPath", "providerPath"]) {
    if (typeof value[key] === "string") {
      if (!path2.isAbsolute(value[key]))
        throw new Error(`${key} must be an absolute path.`);
      next[key] = path2.normalize(value[key]);
    }
  }
  if (value.launchLabel !== undefined) {
    if (typeof value.launchLabel !== "string" || !/^([a-zA-Z0-9_.-]{1,120})?$/.test(value.launchLabel))
      throw new Error("Invalid LaunchAgent label.");
    next.launchLabel = value.launchLabel;
  }
  if (value.autoSync !== undefined)
    next.autoSync = value.autoSync === true;
  await atomic(path2.join(stateDir, "settings.json"), JSON.stringify(next, null, 2));
  return next;
}
async function request(url, options = {}, max = 5 * 1024 * 1024) {
  const r = await fetch(url, { ...options, signal: AbortSignal.timeout(15000), redirect: "error" });
  if (!r.ok)
    throw new Error(`Request failed (HTTP ${r.status}).`);
  const bytes = await limited(r, max);
  return JSON.parse(bytes.toString("utf8"));
}
async function limited(r, max) {
  const chunks = [];
  let size = 0;
  if (!r.body)
    throw new Error("Empty response.");
  for await (const x of r.body) {
    size += x.length;
    if (size > max)
      throw new Error("Download exceeds size limit.");
    chunks.push(Buffer.from(x));
  }
  return Buffer.concat(chunks);
}
async function health() {
  try {
    return await request("http://127.0.0.1:8080/healthz");
  } catch {
    return null;
  }
}
async function gatewayKey(s) {
  const c = parseConfig(await readFile2(s.configPath, "utf8"));
  const key = c.server_keys?.[0];
  if (typeof key !== "string" || !key)
    throw new Error("Gateway has no local API key.");
  return key;
}
async function catalog(s) {
  return (await request("http://127.0.0.1:8080/v1/models", { headers: { Authorization: `Bearer ${await gatewayKey(s)}` } })).data;
}
var releaseCache = null;
async function release(force = false) {
  if (!releaseCache) {
    try {
      releaseCache = JSON.parse(await readFile2(path2.join(stateDir, "release.json"), "utf8"));
    } catch {}
  }
  if (!force && releaseCache && Date.now() - releaseCache.checkedAt < 3600000)
    return releaseCache;
  try {
    const r = await request(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "opencode2api-manager" } });
    if (r.draft || r.prerelease || !/^v\d+\.\d+\.\d+$/.test(r.tag_name))
      throw new Error("No stable release found.");
    releaseCache = { tag: r.tag_name, url: `https://github.com/${REPO}/releases/tag/${r.tag_name}`, notes: String(r.body ?? "").slice(0, 20000), assets: r.assets, checkedAt: Date.now() };
    await atomic(path2.join(stateDir, "release.json"), JSON.stringify(releaseCache));
    return releaseCache;
  } catch {
    if (releaseCache)
      return { ...releaseCache, stale: true };
    return { error: "Release check unavailable. Try again later." };
  }
}
async function snapshot(force = false) {
  const s = await settings();
  const [h, r] = await Promise.all([health(), release(force)]);
  let warp = null;
  try {
    const c = parseConfig(await readFile2(s.configPath, "utf8"));
    warp = c.warp ?? { enabled: false, pool_size: 2, stack: "ipv6" };
  } catch {}
  let sync = null;
  try {
    sync = JSON.parse(await readFile2(path2.join(stateDir, "sync.json"), "utf8"));
  } catch {}
  return { platform: process.platform, arch: process.arch, settings: s, installed: existsSync(s.binary), configured: existsSync(s.configPath), health: h, release: { tag: r.tag, url: r.url, notes: r.notes, checkedAt: r.checkedAt, stale: r.stale, error: r.error }, updateAvailable: !!h && newer(r.tag ?? "", h.version ?? ""), warp, sync };
}
async function backup(file) {
  const dest = path2.join(stateDir, "backups", `${Date.now()}-${randomBytes(3).toString("hex")}-${path2.basename(file)}`);
  await mkdir(path2.dirname(dest), { recursive: true, mode: 448 });
  await copyFile(file, dest);
  await chmod(dest, 384);
  return dest;
}
async function syncModels() {
  const s = await settings();
  const rows = await catalog(s);
  const original = await readFile2(s.providerPath, "utf8");
  const merged = mergeCatalog(original, rows);
  if (merged.text !== original) {
    await backup(s.providerPath);
    await atomic(s.providerPath, merged.text, original);
  }
  const result = { at: new Date().toISOString(), count: merged.count, added: merged.added, changed: merged.text !== original };
  await atomic(path2.join(stateDir, "sync.json"), JSON.stringify(result));
  return result;
}
async function connectProvider(legacy = false) {
  const s = await settings();
  let original = `{}
`;
  try {
    original = await readFile2(s.providerPath, "utf8");
  } catch {}
  const c = parseConfig(original);
  if (c.providers?.opencode2api || c.provider?.opencode2api)
    return syncModels();
  const provider = legacy ? { name: "opencode2api Local", npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:8080/v1" }, models: {} } : { name: "opencode2api Local", package: "aisdk:@ai-sdk/openai-compatible", settings: { baseURL: "http://127.0.0.1:8080/v1" }, models: {} };
  let next = edit(original, [legacy ? "provider" : "providers", "opencode2api"], provider);
  next = mergeCatalog(next, await catalog(s)).text;
  if (existsSync(s.providerPath))
    await backup(s.providerPath);
  await atomic(s.providerPath, next, existsSync(s.providerPath) ? original : undefined);
  return { message: "Provider and models configured. Connect its local key once in Settings → Providers or OpenCode /connect." };
}
async function readLocalKey() {
  return { key: await gatewayKey(await settings()) };
}
async function serviceControl(action) {
  const s = await settings();
  if (!existsSync(s.binary))
    throw new Error("Gateway not installed. Use Install first.");
  await control(action, s, stateDir, path2.join(s.root, "manager-gateway.log"));
  if (action !== "stop")
    await waitHealthy();
  return { message: `Gateway ${action} completed.` };
}
async function waitHealthy(version) {
  for (let i = 0;i < 45; i++) {
    const h = await health();
    if (h?.ready && (!version || h.version === version))
      return h;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Gateway did not become ready within 45 seconds. Check logs.");
}
async function setWarp(value) {
  if (typeof value.enabled !== "boolean" || !Number.isInteger(value.poolSize) || value.poolSize < 1 || value.poolSize > 32 || !["ipv6", "ipv4", "dual"].includes(value.stack))
    throw new Error("Invalid WARP settings.");
  if (value.enabled && value.acceptWarpTerms !== true)
    throw new Error("Read and accept Cloudflare WARP terms before enabling its tunnel.");
  const s = await settings();
  const old = await readFile2(s.configPath, "utf8");
  const c = parseConfig(old);
  const next = edit(old, ["warp"], { ...c.warp, enabled: value.enabled, pool_size: value.poolSize, stack: value.stack, source_ipv6: c.warp?.source_ipv6 ?? "" });
  await backup(s.configPath);
  await atomic(s.configPath, next, old);
  try {
    await serviceControl("restart");
  } catch {
    await atomic(s.configPath, old);
    try {
      await serviceControl("restart");
    } catch {}
    throw new Error("WARP change failed; previous configuration restored. Check gateway logs.");
  }
  return { message: "WARP settings saved and gateway restarted." };
}
async function download(url, max) {
  let current = url;
  for (let i = 0;i < 6; i++) {
    const u = new URL(current);
    if (u.protocol !== "https:" || !["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(u.hostname))
      throw new Error("Unexpected release download host.");
    const r = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(120000) });
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      current = new URL(r.headers.get("location") ?? "", current).href;
      continue;
    }
    if (!r.ok)
      throw new Error(`Release download failed (${r.status}).`);
    return limited(r, max);
  }
  throw new Error("Too many download redirects.");
}
async function stageRelease() {
  const r = await release(true);
  if (!r.tag || r.stale)
    throw new Error("Cannot update without a fresh release check.");
  const name = assetName(process.platform, process.arch, r.tag);
  if (!r.assets?.some((a) => a.name === name) || !r.assets?.some((a) => a.name === name + ".sha256"))
    throw new Error("No official archive/checksum for this platform.");
  const base = `https://github.com/${REPO}/releases/download/${r.tag}/`;
  const bytes = await download(base + name, 150 * 1024 * 1024);
  const sum = (await download(base + name + ".sha256", 4096)).toString("utf8").trim().split(/\s+/)[0];
  if (!/^[a-fA-F0-9]{64}$/.test(sum ?? "") || createHash("sha256").update(bytes).digest("hex") !== sum.toLowerCase())
    throw new Error("Checksum verification failed.");
  const dir = path2.join(stateDir, "staging", randomBytes(8).toString("hex"));
  await mkdir(dir, { recursive: true, mode: 448 });
  const archive = path2.join(dir, name);
  await writeFile2(archive, bytes);
  const out = path2.join(dir, "unpacked");
  await mkdir(out);
  if (process.platform === "win32")
    await ps('Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead($env:OC2_ARCHIVE); try { foreach($e in $z.Entries) { if($e.FullName -match "(^[/\\\\]|^[A-Za-z]:|(^|[/\\\\])\\.\\.([/\\\\]|$))") { throw "Unsafe ZIP path" } } } finally { $z.Dispose() }; Expand-Archive -LiteralPath $env:OC2_ARCHIVE -DestinationPath $env:OC2_DEST', { OC2_ARCHIVE: archive, OC2_DEST: out });
  else {
    const entries = (await command("tar", ["-tzf", archive])).split(`
`);
    validateArchiveEntries(entries);
    const verbose = await command("tar", ["-tvzf", archive]);
    if (verbose.split(`
`).some((x) => /^[lh]/.test(x)))
      throw new Error("Archive links are not supported.");
    await command("tar", ["-xzf", archive, "-C", out]);
  }
  async function find(dir2) {
    let found = [];
    for (const e of await readdir(dir2, { withFileTypes: true })) {
      const p = path2.join(dir2, e.name);
      if (e.isSymbolicLink())
        throw new Error("Archive contains a symbolic link.");
      if (e.isDirectory())
        found.push(...await find(p));
      else if (e.name === (process.platform === "win32" ? "opencode2api.exe" : "opencode2api"))
        found.push(p);
    }
    return found;
  }
  const bins = await find(out);
  if (bins.length !== 1)
    throw new Error("Archive must contain exactly one gateway binary.");
  if (process.platform !== "win32")
    await chmod(bins[0], 493);
  return { binary: bins[0], version: r.tag, dir };
}
async function install() {
  const s = await settings();
  if (existsSync(s.binary) || existsSync(s.configPath))
    throw new Error("Existing installation/config detected. Use Update or configure its paths instead.");
  if (await health())
    throw new Error("Port 8080 already has a running gateway.");
  const staged = await stageRelease();
  await mkdir(s.root, { recursive: true, mode: 448 });
  await mkdir(path2.dirname(s.binary), { recursive: true });
  await copyFile(staged.binary, s.binary);
  if (process.platform !== "win32")
    await chmod(s.binary, 493);
  const c = { listen: "127.0.0.1:8080", server_keys: ["oc2-" + randomBytes(32).toString("hex")], zen_keys: [], go_keys: [], anonymous: true, proxies: ["direct"], models: { refresh_seconds: 300, free_only: true, active_probes: false }, retry: { max_attempts: 3, timeout_seconds: 300 }, warp: { enabled: false, pool_size: 4, stack: "ipv6", source_ipv6: "" }, webui: { enabled: false } };
  await atomic(s.configPath, JSON.stringify(c, null, 2) + `
`);
  await saveSettings(s);
  await control("start", s, stateDir, path2.join(s.root, "manager-gateway.log"));
  await waitHealthy(staged.version);
  await rm(staged.dir, { recursive: true, force: true });
  return { message: "Installed and started. Next: Add provider, then connect its local key. WARP starts off; enable it separately after accepting its terms." };
}
async function update() {
  const s = await settings();
  if (!existsSync(s.binary))
    return install();
  if (!await health())
    throw new Error("Start the gateway before updating so rollback can be verified.");
  const staged = await stageRelease();
  const oldVersion = (await health())?.version;
  if (oldVersion === staged.version) {
    await rm(staged.dir, { recursive: true, force: true });
    return { message: "Already up to date." };
  }
  await backup(s.configPath);
  const old = await backup(s.binary);
  const replacement = s.binary + ".manager-new";
  await copyFile(staged.binary, replacement);
  if (process.platform !== "win32")
    await chmod(replacement, 493);
  try {
    await control("stop", s, stateDir, path2.join(s.root, "manager-gateway.log"));
    await rename(replacement, s.binary);
    await control("start", s, stateDir, path2.join(s.root, "manager-gateway.log"));
    await waitHealthy(staged.version);
  } catch {
    try {
      await control("stop", s, stateDir, path2.join(s.root, "manager-gateway.log"));
    } catch {}
    await copyFile(old, s.binary);
    if (process.platform !== "win32")
      await chmod(s.binary, 493);
    try {
      await control("start", s, stateDir, path2.join(s.root, "manager-gateway.log"));
      await waitHealthy(oldVersion);
    } catch {
      throw new Error("Update failed; old binary restored but restart needs attention.");
    }
    throw new Error("Update failed; previous binary restored and restarted.");
  } finally {
    await rm(replacement, { force: true });
    await rm(staged.dir, { recursive: true, force: true });
  }
  return { message: `Updated to ${staged.version}.` };
}
async function logs() {
  const s = await settings();
  const file = existsSync(path2.join(s.root, "service.log")) ? path2.join(s.root, "service.log") : path2.join(s.root, "manager-gateway.log");
  try {
    const f = await open2(file, "r");
    try {
      const size = (await f.stat()).size;
      const buffer = Buffer.alloc(Math.min(size, 64000));
      await f.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      const rows = buffer.toString("utf8").split(`
`).slice(-100).flatMap((line) => {
        try {
          const x = JSON.parse(line);
          return [{ time: x.time, level: x.level, event: x.event, component: x.component, status: x.status, model: x.model, attempts: x.attempts, duration_ms: x.duration_ms, outcome: x.outcome }];
        } catch {
          return [];
        }
      });
      return { rows };
    } finally {
      await f.close();
    }
  } catch {
    return { rows: [], message: "No structured gateway logs yet." };
  }
}
async function exclusive(fn) {
  await mkdir(stateDir, { recursive: true, mode: 448 });
  const lock = path2.join(stateDir, "operation.lock");
  let handle;
  try {
    handle = await open2(lock, "wx", 384);
  } catch {
    throw new Error("Another manager operation is running. If a crashed process left operation.lock, remove it after confirming no update is active.");
  }
  try {
    return await fn();
  } finally {
    await handle.close();
    await rm(lock, { force: true });
  }
}

// service/main.ts
var token = process.env.OPENCHAMBER_SERVICE_TOKEN;
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
if (!token || !Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Service port/token missing. Start through OpenChamber.");
var host = process.env.OPENCHAMBER_HOST_CALLBACK_URL ? createServiceHost({ env: process.env }) : null;
var job = null;
var healthCache = null;
var cacheAt = 0;
async function info(force = false) {
  if (force || Date.now() - cacheAt > 1e4) {
    healthCache = await snapshot(force);
    cacheAt = Date.now();
  }
  return { ...healthCache, job };
}
var operations = { install: () => install(), update: () => update(), start: () => serviceControl("start"), stop: () => serviceControl("stop"), restart: () => serviceControl("restart"), warp: (d) => setWarp(d), sync: () => syncModels(), connect: (d) => connectProvider(d.legacy === true) };
async function run(op, data) {
  if (!operations[op])
    throw new Error("Unknown operation.");
  if (job?.status === "running")
    throw new Error("An operation is already running.");
  job = { operation: op, status: "running", startedAt: Date.now() };
  exclusive(() => operations[op](data)).then((result) => {
    job = { ...job, status: "ok", result };
  }, (error) => {
    job = { ...job, status: "error", message: error instanceof Error ? error.message : "Operation failed." };
  }).finally(async () => {
    cacheAt = 0;
    try {
      await host?.emit("manager-changed", {});
    } catch {}
  });
  return { accepted: true, job };
}
async function route(method, path3, body) {
  if (method === "GET" && path3 === "/health")
    return { ok: true };
  if (method === "GET" && path3 === "/snapshot")
    return info();
  if (method === "GET" && path3 === "/logs")
    return logs();
  if (method === "POST" && path3 === "/check")
    return info(true);
  if (method === "POST" && path3 === "/settings") {
    const result = await exclusive(() => saveSettings(body));
    cacheAt = 0;
    return result;
  }
  if (method === "POST" && path3 === "/local-key")
    return readLocalKey();
  if (method === "POST" && path3 === "/action")
    return run(body.action, body);
  if (method === "POST" && path3 === "/schedule") {
    (async () => {
      await release();
      const s = await settings();
      if (s.autoSync && !job?.status?.includes("running"))
        await exclusive(() => syncModels());
      cacheAt = 0;
    })().catch(() => {});
    return { ok: true };
  }
  if (path3 === "/status" && method === "POST") {
    if (body.id === "check") {
      await release(true);
      cacheAt = 0;
      return { ok: true };
    }
    throw new Error("Unknown status action.");
  }
  if (path3 === "/status" && method === "GET") {
    const x = await info();
    return { rows: [
      { kind: "line", id: "gateway", label: "Gateway", dot: x.health?.ready ? "success" : "warning", value: x.health?.version ?? (x.installed ? "Stopped" : "Not installed") },
      { kind: "line", id: "version", label: "Updates", value: x.release.error ? "Check unavailable" : x.updateAvailable ? `${x.release.tag} available` : x.release.tag ? `Latest ${x.release.tag}` : "Not checked", valueTone: x.updateAvailable ? "warning" : "muted", actions: [{ kind: "button", id: "check", label: "Check", variant: "outline" }] },
      { kind: "line", id: "warp", label: "WARP", value: x.health?.warp ? `${x.health.warp.active ?? 0} active · ${x.health.warp.standby ?? 0} standby · ${x.health.warp.cooling ?? 0} cooling` : x.warp?.enabled ? "Starting" : "Off" },
      { kind: "line", id: "models", label: "Models", value: `${x.health?.models?.exposed ?? "—"} · sync ${x.settings.autoSync ? "on" : "off"}` },
      ...job?.status === "running" ? [{ kind: "note", id: "job", text: `${job.operation} in progress…`, tone: "info" }] : []
    ] };
  }
  return null;
}
http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401).end();
    return;
  }
  let raw = "";
  let tooLarge = false;
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > 65536) {
      tooLarge = true;
      req.destroy();
    }
  });
  req.on("end", () => {
    if (tooLarge)
      return;
    let body = {};
    try {
      if (raw)
        body = JSON.parse(raw);
    } catch {
      res.writeHead(400).end('{"message":"Invalid JSON"}');
      return;
    }
    route(req.method ?? "GET", new URL(req.url ?? "/", "http://localhost").pathname, body).then((answer) => {
      res.writeHead(answer === null ? 404 : 200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(answer ?? {}));
    }, (error) => {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ message: error instanceof Error ? error.message : "Request failed." }));
    });
  });
}).listen(port, "127.0.0.1");
