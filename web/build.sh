#!/bin/sh
# Builds the core to a standalone WebAssembly module for web/core-worklet.js, from the repo root:
#   sh web/build.sh
set -e
em++ -std=c++17 -O2 --no-entry -sSTANDALONE_WASM -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=32MB \
  -sEXPORTED_FUNCTIONS=_fs_create,_fs_destroy,_fs_prepare,_fs_set_param,_fs_param_count,_fs_in,_fs_out,_fs_process,_fs_set_source,_fs_set_source_i16,_fs_stats,_fs_mix_create,_fs_mix_prepare,_fs_mix_add,_fs_mix_set_gain,_fs_mix_set_ramp,_fs_mix_set_lowpass,_fs_mix_process,_fs_mix_out,_fs_mix_stats,_fs_piece_add_route,_fs_piece_walk,_fs_piece_route,_fs_piece_sect_n,_fs_piece_bed_voices,_fs_piece_sector,_fs_piece_sector_now,_fs_piece_character,_fs_piece_zone,_fs_piece_rhythm_add,_fs_piece_rhythm_gain,_fs_piece_rhythm_source,_fs_piece_rhythm_remove,_fs_alloc_i16,_fs_engine_create,_fs_engine_features,_fs_engine_places,_fs_engine_step,_fs_engine_source,_fs_engine_process,_fs_engine_out,_fs_engine_state,_malloc,_free \
  core/core.cpp core/mix.cpp core/place.cpp core/sections.cpp core/webm.cpp core/resample.cpp core/piece.cpp core/engine.cpp core/devices/*.cpp -o web/core.wasm
