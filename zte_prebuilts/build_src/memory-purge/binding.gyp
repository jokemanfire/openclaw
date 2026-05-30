{
  "targets": [{
    "target_name": "memory_purge",
    "sources": [ "memory_purge.cc" ],
    "cflags_cc": [
      "-std=c++17",
      "-fno-exceptions",
      "-fno-rtti",
      "-fvisibility=hidden",
      "-O2",
      "-Wall",
      "-Wextra"
    ],
    "ldflags": [
      "-Wl,--no-undefined"
    ],
    "defines": [
      "NAPI_VERSION=8",
      "_GNU_SOURCE"
    ]
  }]
}
