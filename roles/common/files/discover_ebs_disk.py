#!/usr/bin/env python3
"""Resolve an EC2 attachment name to a whole EBS NVMe device, without writes."""

import json
import subprocess
import sys


def attachment_name(controller):
    # NVMe Identify Controller: model at bytes 24..63; Amazon's block-device
    # name occupies the first 32 bytes of the vendor-specific area at 3072.
    # Layout: https://github.com/amazonlinux/amazon-ec2-utils/blob/main/ebsnvme
    if len(controller) != 4096:
        raise ValueError("Incomplete NVMe controller identification")
    model = controller[24:64].decode("ascii").strip(" \x00")
    if model != "Amazon Elastic Block Store":
        raise ValueError("Device is not Amazon EBS")
    name = controller[3072:3104].decode("ascii").strip(" \x00")
    # Launch-time attachments may omit /dev/; later attachments include it.
    return name.removeprefix("/dev/")


def has_partitions_or_root(device):
    if device.get("type") == "part" or "/" in (device.get("mountpoints") or []):
        return True
    return any(has_partitions_or_root(child) for child in device.get("children", []))


def discover(requested):
    name = requested.removeprefix("/dev/")
    if not name or "/" in name:
        raise ValueError("Expected an EC2 block-device attachment name, e.g. /dev/sdg")
    listing = json.loads(subprocess.check_output(
        ["lsblk", "--json", "--paths", "--output", "NAME,TYPE,MODEL,MOUNTPOINTS"],
        text=True,
    ))
    matches = []
    for device in listing["blockdevices"]:
        if device.get("type") != "disk" or (device.get("model") or "").strip() != "Amazon Elastic Block Store":
            continue
        controller = subprocess.check_output(["nvme", "id-ctrl", "--raw-binary", device["name"]])
        if attachment_name(controller) == name:
            if has_partitions_or_root(device):
                raise ValueError(f"Refusing partitioned or root device {device['name']}")
            matches.append(device["name"])
    if len(matches) != 1:
        raise ValueError(f"Expected exactly one EBS device attached as {requested}; found {len(matches)}")
    return matches[0]


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("Usage: discover_ebs_disk.py /dev/sdg")
        print(discover(sys.argv[1]))
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(f"EBS discovery failed: {error}", file=sys.stderr)
        sys.exit(1)
