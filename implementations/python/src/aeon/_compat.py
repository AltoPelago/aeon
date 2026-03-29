from __future__ import annotations

import sys
from dataclasses import dataclass as _dataclass


def dataclass(*args, **kwargs):
    if sys.version_info < (3, 10):
        kwargs.pop("slots", None)
    return _dataclass(*args, **kwargs)
