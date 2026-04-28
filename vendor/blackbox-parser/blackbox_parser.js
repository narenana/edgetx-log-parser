/* @ts-self-types="./blackbox_parser.d.ts" */
import * as wasm from "./blackbox_parser_bg.wasm";
import { __wbg_set_wasm } from "./blackbox_parser_bg.js";

__wbg_set_wasm(wasm);

export {
    FlightLog, parseBlackbox
} from "./blackbox_parser_bg.js";
