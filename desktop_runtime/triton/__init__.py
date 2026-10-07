"""Disable the optional Triton backend in the local desktop runtime.

The desktop launcher keeps Triton out of the import path because the optional
Windows package can crash before ComfyUI has a chance to report an error.
"""

raise ImportError("Triton is disabled by the ComfyUI desktop runtime")
