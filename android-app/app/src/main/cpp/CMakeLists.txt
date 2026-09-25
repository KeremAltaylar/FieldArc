# The shared core (repo core/) plus the JNI bridge, as one library the app loads.
cmake_minimum_required(VERSION 3.22.1)
project(fieldscape CXX)
set(CMAKE_CXX_STANDARD 17)
set(CORE ${CMAKE_CURRENT_SOURCE_DIR}/../../../../../core)
file(GLOB DEVICES ${CORE}/devices/*.cpp)
add_library(fieldscape SHARED jni.cpp ${CORE}/core.cpp ${CORE}/mix.cpp ${CORE}/place.cpp ${CORE}/sections.cpp ${CORE}/webm.cpp ${CORE}/resample.cpp ${CORE}/piece.cpp ${DEVICES})
# optimised even in debug builds: the audio thread must keep up on the emulator and a phone
target_compile_options(fieldscape PRIVATE -O2)
target_include_directories(fieldscape PRIVATE ${CORE})
target_link_libraries(fieldscape aaudio log)
