import { readFileSync } from "node:fs";
import type { MappedRegion, ProcStatus, SmapsRollup } from "../types.js";

export function parseSmaps(): MappedRegion[] {
  try {
    const raw = readFileSync("/proc/self/smaps", "utf-8");
    const regionMap = new Map<string, MappedRegion>();
    let currentPath = "[anonymous]";
    let currentVss = 0;
    let rss = 0;
    let pss = 0;
    let sharedClean = 0;
    let sharedDirty = 0;
    let privateClean = 0;
    let privateDirty = 0;

    for (const line of raw.split("\n")) {
      if (line.includes("-") && line.includes(" ")) {
        if (currentVss > 0) {
          const existing = regionMap.get(currentPath);
          if (existing) {
            existing.rss += rss;
            existing.pss += pss;
            existing.sharedClean += sharedClean;
            existing.sharedDirty += sharedDirty;
            existing.privateClean += privateClean;
            existing.privateDirty += privateDirty;
            existing.vss += currentVss;
            existing.regionCount += 1;
          } else {
            regionMap.set(currentPath, {
              path: currentPath,
              rss,
              pss,
              sharedClean,
              sharedDirty,
              privateClean,
              privateDirty,
              vss: currentVss,
              regionCount: 1,
            });
          }
        }
        const parts = line.trim().split(/\s+/);
        currentPath = parts.length >= 6 ? (parts[5] ?? "[anonymous]") : "[anonymous]";
        const rangeParts = (parts[0] ?? "0-0").split("-");
        currentVss = parseInt(rangeParts[1] ?? "0", 16) - parseInt(rangeParts[0] ?? "0", 16);
        rss = pss = sharedClean = sharedDirty = privateClean = privateDirty = 0;
      } else if (line.startsWith("Rss:")) {
        rss = parseInt(line.split(/\s+/)[1] ?? "0", 10) * 1024;
      } else if (line.startsWith("Pss:")) {
        pss = parseInt(line.split(/\s+/)[1] ?? "0", 10) * 1024;
      } else if (line.startsWith("Shared_Clean:")) {
        sharedClean = parseInt(line.split(/\s+/)[1] ?? "0", 10) * 1024;
      } else if (line.startsWith("Shared_Dirty:")) {
        sharedDirty = parseInt(line.split(/\s+/)[1] ?? "0", 10) * 1024;
      } else if (line.startsWith("Private_Clean:")) {
        privateClean = parseInt(line.split(/\s+/)[1] ?? "0", 10) * 1024;
      } else if (line.startsWith("Private_Dirty:")) {
        privateDirty = parseInt(line.split(/\s+/)[1] ?? "0", 10) * 1024;
      }
    }
    if (currentVss > 0) {
      const existing = regionMap.get(currentPath);
      if (existing) {
        existing.rss += rss;
        existing.pss += pss;
        existing.sharedClean += sharedClean;
        existing.sharedDirty += sharedDirty;
        existing.privateClean += privateClean;
        existing.privateDirty += privateDirty;
        existing.vss += currentVss;
        existing.regionCount += 1;
      } else {
        regionMap.set(currentPath, {
          path: currentPath,
          rss,
          pss,
          sharedClean,
          sharedDirty,
          privateClean,
          privateDirty,
          vss: currentVss,
          regionCount: 1,
        });
      }
    }
    return [...regionMap.values()].sort((a, b) => b.rss - a.rss);
  } catch {
    return [];
  }
}

export function parseProcStatus(): ProcStatus | null {
  try {
    const raw = readFileSync("/proc/self/status", "utf-8");
    let vmPeak = 0,
      vmSize = 0,
      vmRSS = 0,
      vmHWM = 0,
      vmData = 0,
      vmStk = 0;
    let rssAnon = 0,
      rssFile = 0,
      rssShmem = 0;
    let threads = 0;

    for (const line of raw.split("\n")) {
      const m = /^(\w+):\s+(\d+)/.exec(line);
      if (!m) continue;
      const v = parseInt(m[2] ?? "0", 10) * 1024;
      switch (m[1]) {
        case "VmPeak":
          vmPeak = v;
          break;
        case "VmSize":
          vmSize = v;
          break;
        case "VmRSS":
          vmRSS = v;
          break;
        case "VmHWM":
          vmHWM = v;
          break;
        case "VmData":
          vmData = v;
          break;
        case "VmStk":
          vmStk = v;
          break;
        case "RssAnon":
          rssAnon = v;
          break;
        case "RssFile":
          rssFile = v;
          break;
        case "RssShmem":
          rssShmem = v;
          break;
        case "Threads":
          threads = parseInt(m[2] ?? "0", 10);
          break;
      }
    }
    return { vmPeak, vmSize, vmRSS, vmHWM, vmData, vmStk, rssAnon, rssFile, rssShmem, threads };
  } catch {
    return null;
  }
}

export function parseSmapsRollup(): SmapsRollup | null {
  try {
    const raw = readFileSync("/proc/self/smaps_rollup", "utf-8");
    let rss = 0,
      pss = 0,
      anonymous = 0,
      fileBacked = 0;
    let sharedClean = 0,
      sharedDirty = 0,
      privateClean = 0,
      privateDirty = 0;

    for (const line of raw.split("\n")) {
      const parts = line.trim().split(/\s+/);
      const v = parseInt(parts[1] ?? "0", 10) * 1024;
      if (line.startsWith("Rss:")) rss = v;
      else if (line.startsWith("Pss:")) pss = v;
      else if (line.startsWith("Anonymous:")) anonymous = v;
      else if (line.startsWith("FilePagemap") || !line) continue;
      else if (line.startsWith("Shared_Clean:")) sharedClean = v;
      else if (line.startsWith("Shared_Dirty:")) sharedDirty = v;
      else if (line.startsWith("Private_Clean:")) privateClean = v;
      else if (line.startsWith("Private_Dirty:")) privateDirty = v;
    }

    fileBacked = rss - anonymous;
    return { rss, pss, anonymous, fileBacked, sharedClean, sharedDirty, privateClean, privateDirty };
  } catch {
    return null;
  }
}
