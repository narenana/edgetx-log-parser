/*
 * WASM facade around iNAV's blackbox-tools parser.
 *
 * Strategy: write the user-supplied bytes into Emscripten's in-memory
 * filesystem (MEMFS) at /tmp/log.bbl, then call the existing
 * flightLogCreate(fd) entry point. This avoids any patches to upstream
 * source — when iNAV ships parser fixes we just refresh the vendored
 * source files.
 *
 * The C-side API exposed to JS is minimal and pull-based:
 *
 *     int  bb_open(const char* data, int len);
 *          // 1 = ok, 0 = failed
 *     int  bb_main_field_count();
 *     const char* bb_main_field_name(int i);
 *     int  bb_main_frame_count();
 *     int64_t bb_main_frame_value(int frame, int field);
 *     // (similar for slow/gps frames + a free)
 *
 * The actual parsing happens inside bb_open() via flightLogParse().
 * Frame callbacks accumulate the i64 values into flat heap-allocated
 * arrays which JS reads after parse completes (one allocation per
 * frame stream, bounded by the file size, no per-frame JsValue churn).
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdbool.h>
#include <stdint.h>
#include <emscripten.h>

#include "parser.h"
#include "blackbox_fielddefs.h"

#define BB_MEMFS_PATH "/tmp/bb_log.bbl"

/* ---------- frame accumulators ---------- */

typedef struct frame_buffer_t {
    int field_count;
    int frame_count;
    int frame_capacity;
    int64_t *values;   /* flat row-major: values[frame * field_count + field] */
} frame_buffer_t;

static flightLog_t *g_log = NULL;
static frame_buffer_t g_main = {0};
static frame_buffer_t g_slow = {0};
static frame_buffer_t g_gps  = {0};
static int g_diag_main_seen = 0, g_diag_main_invalid = 0;
static int g_diag_slow_seen = 0, g_diag_slow_invalid = 0;
static int g_diag_gps_seen = 0, g_diag_gps_invalid = 0;

/* Field name strings for each frame kind, joined into a single buffer of
 * NUL-separated strings; bb_main_field_name() returns a stable pointer
 * into this. */
static char *g_main_names_blob = NULL;
static char **g_main_name_ptrs = NULL;
static int g_main_name_count = 0;
static char *g_slow_names_blob = NULL;
static char **g_slow_name_ptrs = NULL;
static int g_slow_name_count = 0;
static char *g_gps_names_blob = NULL;
static char **g_gps_name_ptrs = NULL;
static int g_gps_name_count = 0;
static char *g_main_signed = NULL; /* one byte per field, 0/1 */
static char *g_slow_signed = NULL;
static char *g_gps_signed = NULL;

/* Generic helper: ensure the buffer can hold one more frame, growing 2x. */
static void buf_ensure_capacity(frame_buffer_t *b) {
    if (b->frame_count + 1 > b->frame_capacity) {
        int new_cap = b->frame_capacity == 0 ? 1024 : b->frame_capacity * 2;
        b->values = (int64_t*) realloc(b->values, (size_t) new_cap * (size_t) b->field_count * sizeof(int64_t));
        b->frame_capacity = new_cap;
    }
}

static void buf_push(frame_buffer_t *b, int64_t *frame) {
    if (b->field_count <= 0) return;
    buf_ensure_capacity(b);
    memcpy(&b->values[(size_t) b->frame_count * (size_t) b->field_count],
           frame,
           (size_t) b->field_count * sizeof(int64_t));
    b->frame_count++;
}

/* ---------- callbacks from flightLogParse ---------- */

static void on_metadata_ready(flightLog_t *log) {
    /* nothing extra to do — the field schema is already populated. */
    (void) log;
}

static void on_frame_ready(flightLog_t *log, bool valid, int64_t *frame, uint8_t kind, int field_count, int frame_offset, int frame_size) {
    (void) log; (void) frame_offset; (void) frame_size;
    if (kind == 'I' || kind == 'P') {
        g_diag_main_seen++;
        if (!valid) { g_diag_main_invalid++; return; }
        if (g_main.field_count == 0) g_main.field_count = field_count;
        if (g_main.field_count == field_count) buf_push(&g_main, frame);
    } else if (kind == 'S') {
        g_diag_slow_seen++;
        if (!valid) { g_diag_slow_invalid++; return; }
        if (g_slow.field_count == 0) g_slow.field_count = field_count;
        if (g_slow.field_count == field_count) buf_push(&g_slow, frame);
    } else if (kind == 'G') {
        g_diag_gps_seen++;
        if (!valid) { g_diag_gps_invalid++; return; }
        if (g_gps.field_count == 0) g_gps.field_count = field_count;
        if (g_gps.field_count == field_count) buf_push(&g_gps, frame);
    }
}

EMSCRIPTEN_KEEPALIVE int bb_diag_main_seen(void) { return g_diag_main_seen; }
EMSCRIPTEN_KEEPALIVE int bb_diag_main_invalid(void) { return g_diag_main_invalid; }
EMSCRIPTEN_KEEPALIVE int bb_diag_slow_seen(void) { return g_diag_slow_seen; }
EMSCRIPTEN_KEEPALIVE int bb_diag_gps_seen(void) { return g_diag_gps_seen; }
EMSCRIPTEN_KEEPALIVE int bb_diag_total_corrupt(void) {
    if (!g_log) return -1;
    return (int) g_log->stats.totalCorruptFrames;
}

static void on_event(flightLog_t *log, flightLogEvent_t *event) {
    /* Events surfaced in v1: skipping for now. */
    (void) log; (void) event;
}

/* ---------- internal helpers to copy field name/signed arrays ---------- */

static void copy_field_schema(flightLogFrameDef_t *def,
                              char **out_blob, char ***out_ptrs, int *out_count,
                              char **out_signed) {
    int n = def->fieldCount;
    if (n <= 0) return;

    /* total bytes needed for joined names. */
    size_t total = 0;
    for (int i = 0; i < n; i++) {
        const char *name = def->fieldName[i] ? def->fieldName[i] : "";
        total += strlen(name) + 1;
    }
    char *blob = (char*) malloc(total);
    char **ptrs = (char**) malloc((size_t) n * sizeof(char*));
    char *cursor = blob;
    for (int i = 0; i < n; i++) {
        const char *name = def->fieldName[i] ? def->fieldName[i] : "";
        size_t len = strlen(name) + 1;
        memcpy(cursor, name, len);
        ptrs[i] = cursor;
        cursor += len;
    }
    char *signedness = (char*) malloc((size_t) n);
    for (int i = 0; i < n; i++) {
        signedness[i] = (char) (def->fieldSigned[i] ? 1 : 0);
    }

    *out_blob = blob;
    *out_ptrs = ptrs;
    *out_count = n;
    *out_signed = signedness;
}

static void free_schema(char **blob, char ***ptrs, int *count, char **signed_arr) {
    if (*blob) { free(*blob); *blob = NULL; }
    if (*ptrs) { free(*ptrs); *ptrs = NULL; }
    if (*signed_arr) { free(*signed_arr); *signed_arr = NULL; }
    *count = 0;
}

static void reset_buffers(void) {
    if (g_main.values) { free(g_main.values); g_main.values = NULL; }
    if (g_slow.values) { free(g_slow.values); g_slow.values = NULL; }
    if (g_gps.values)  { free(g_gps.values);  g_gps.values  = NULL; }
    memset(&g_main, 0, sizeof(g_main));
    memset(&g_slow, 0, sizeof(g_slow));
    memset(&g_gps,  0, sizeof(g_gps));
    free_schema(&g_main_names_blob, &g_main_name_ptrs, &g_main_name_count, &g_main_signed);
    free_schema(&g_slow_names_blob, &g_slow_name_ptrs, &g_slow_name_count, &g_slow_signed);
    free_schema(&g_gps_names_blob,  &g_gps_name_ptrs,  &g_gps_name_count,  &g_gps_signed);
}

/* ---------- exported API ---------- */

EMSCRIPTEN_KEEPALIVE
int bb_open(const char *data, int len) {
    if (g_log) { flightLogDestroy(g_log); g_log = NULL; }
    reset_buffers();

    /* Stage the bytes into MEMFS so flightLogCreate(fd) can mmap them. */
    FILE *f = fopen(BB_MEMFS_PATH, "wb");
    if (!f) return 0;
    size_t written = fwrite(data, 1, (size_t) len, f);
    fclose(f);
    if ((int) written != len) return 0;

    int fd = open(BB_MEMFS_PATH, O_RDONLY);
    if (fd < 0) return 0;

    g_log = flightLogCreate(fd);
    /* close fd; the mmap stays alive inside the parser until destroy. */
    close(fd);
    if (!g_log) return 0;

    /* Parse the first log section. (Some files split into multiple
     * sub-logs at arm/disarm boundaries; we collapse to log #0 for now —
     * iNAV typically writes a single section per session anyway.) */
    /* raw=false: enable per-frame iteration/time validation
     * (flightLogValidateMainFrameValues). Frames with backwards or
     * far-jumping time/iteration are dropped — what we want for
     * downstream charts. The earlier raw=true experiment let too many
     * post-corrupt-frame predictions through and produced gibberish
     * timestamps. */
    bool ok = flightLogParse(g_log, 0, on_metadata_ready, on_frame_ready, on_event, /*raw=*/false);
    if (!ok) {
        /* parse failed early; keep partial frames if any but return 0. */
    }

    /* Snapshot field schemas after parse. flightLogParse populates the
     * frameDefs for every frame kind it actually saw. */
    if (g_log->frameDefs['I'].fieldCount > 0) {
        copy_field_schema(&g_log->frameDefs['I'], &g_main_names_blob, &g_main_name_ptrs,
                          &g_main_name_count, &g_main_signed);
    }
    if (g_log->frameDefs['S'].fieldCount > 0) {
        copy_field_schema(&g_log->frameDefs['S'], &g_slow_names_blob, &g_slow_name_ptrs,
                          &g_slow_name_count, &g_slow_signed);
    }
    if (g_log->frameDefs['G'].fieldCount > 0) {
        copy_field_schema(&g_log->frameDefs['G'], &g_gps_names_blob, &g_gps_name_ptrs,
                          &g_gps_name_count, &g_gps_signed);
    }

    return ok ? 1 : (g_main.frame_count > 0 ? 1 : 0);
}

EMSCRIPTEN_KEEPALIVE int bb_main_field_count(void) { return g_main_name_count; }
EMSCRIPTEN_KEEPALIVE int bb_slow_field_count(void) { return g_slow_name_count; }
EMSCRIPTEN_KEEPALIVE int bb_gps_field_count(void)  { return g_gps_name_count;  }

EMSCRIPTEN_KEEPALIVE const char* bb_main_field_name(int i) {
    if (i < 0 || i >= g_main_name_count) return "";
    return g_main_name_ptrs[i];
}
EMSCRIPTEN_KEEPALIVE const char* bb_slow_field_name(int i) {
    if (i < 0 || i >= g_slow_name_count) return "";
    return g_slow_name_ptrs[i];
}
EMSCRIPTEN_KEEPALIVE const char* bb_gps_field_name(int i) {
    if (i < 0 || i >= g_gps_name_count) return "";
    return g_gps_name_ptrs[i];
}

EMSCRIPTEN_KEEPALIVE const char* bb_main_field_signed_ptr(void) { return g_main_signed; }
EMSCRIPTEN_KEEPALIVE const char* bb_slow_field_signed_ptr(void) { return g_slow_signed; }
EMSCRIPTEN_KEEPALIVE const char* bb_gps_field_signed_ptr(void)  { return g_gps_signed;  }

EMSCRIPTEN_KEEPALIVE int bb_main_frame_count(void) { return g_main.frame_count; }
EMSCRIPTEN_KEEPALIVE int bb_slow_frame_count(void) { return g_slow.frame_count; }
EMSCRIPTEN_KEEPALIVE int bb_gps_frame_count(void)  { return g_gps.frame_count;  }

/* JS reads frames via these heap pointers + counts — single typed-array
 * view, no per-cell copying. Values are i64; JS reads as BigInt64Array. */
EMSCRIPTEN_KEEPALIVE int64_t* bb_main_frames_ptr(void) { return g_main.values; }
EMSCRIPTEN_KEEPALIVE int64_t* bb_slow_frames_ptr(void) { return g_slow.values; }
EMSCRIPTEN_KEEPALIVE int64_t* bb_gps_frames_ptr(void)  { return g_gps.values;  }

EMSCRIPTEN_KEEPALIVE const char* bb_firmware_revision(void) {
    if (!g_log) return "";
    /* The C parser doesn't expose a single string; reconstruct from sysConfig. */
    static char buf[64];
    const char *type = "Unknown";
    if (g_log->sysConfig.firmwareRevison == FIRMWARE_REVISON_INAV) type = "INAV";
    else if (g_log->sysConfig.firmwareRevison == FIRMWARE_REVISON_BETAFLIGHT) type = "Betaflight";
    snprintf(buf, sizeof(buf), "%s", type);
    return buf;
}

EMSCRIPTEN_KEEPALIVE void bb_close(void) {
    if (g_log) { flightLogDestroy(g_log); g_log = NULL; }
    reset_buffers();
    unlink(BB_MEMFS_PATH);
}
