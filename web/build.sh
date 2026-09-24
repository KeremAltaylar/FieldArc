#!/bin/sh
# Builds the core to a standalone WebAssembly module for web/core-worklet.js, from the repo root:
#   sh web/build.sh
set -e
mkdir -p build/web
em++ -std=c++17 -O2 --no-entry -sSTANDALONE_WASM -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=16MB \
  -sEXPORTED_FUNCTIONS=_fs_create,_fs_destroy,_fs_prepare,_fs_set_param,_fs_param_count,_fs_in,_fs_out,_fs_process,_fs_set_source,_fs_stats,_malloc,_free \
  core/core.cpp core/devices/*.cpp -o build/web/core.wasm
