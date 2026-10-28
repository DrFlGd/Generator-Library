# Runs GenerateSTL's engine (the repository's app/ package) inside the page.
# app.main is the engine's web service; the stand-ins below let it import
# without FastAPI, so the page uses the same request checks, file names and
# generation as the service does.
import io
import json
import re
import sys
import types
import zipfile


class HTTPException(Exception):
    def __init__(self, status_code, detail=None):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class _FastAPI:
    def __init__(self, *args, **kwargs):
        pass

    def add_middleware(self, *args, **kwargs):
        pass

    def _route(self, *args, **kwargs):
        return lambda handler: handler

    get = post = _route


def _module(name, **attrs):
    module = types.ModuleType(name)
    module.__dict__.update(attrs)
    sys.modules[name] = module


_module("fastapi", FastAPI=_FastAPI, HTTPException=HTTPException, Body=lambda *a, **k: None)
_module("fastapi.middleware")
_module("fastapi.middleware.cors", CORSMiddleware=object)
_module("fastapi.responses", Response=object)

from app import main  # noqa: E402


def _field_errors(detail):
    """[{fields, message}] from the engine's 422 detail (a list, or one string)."""
    items = detail if isinstance(detail, list) else [{"loc": (), "msg": str(detail)}]
    out = []
    for item in items:
        loc = [part for part in item.get("loc", ()) if isinstance(part, str)]
        message = re.sub(r"^Value error, ", "", str(item.get("msg", "")))
        fields = loc[-1:]
        # The engine's own checks name their fields first: "a and b: reason", "a, b: reason".
        named = re.match(r"^([A-Za-z_]\w*(?:(?:, | and )[A-Za-z_]\w*)*): (.+)$", message)
        if not fields and named:
            fields = re.split(r", | and ", named[1])
            message = named[2]
        out.append({"fields": fields, "message": message})
    return out


def generate(payload_json):
    """The part's file, and each STL in it for the preview."""
    payload = json.loads(payload_json)
    try:
        request = main._parse_request(payload)
        data = main._generate(request)
    except HTTPException as error:
        return {"errors": _field_errors(error.detail)}
    except ValueError as error:
        return {"errors": _field_errors(str(error))}
    name = main._filename(request)
    if name.lower().endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            parts = [[part, archive.read(part)] for part in archive.namelist() if part.lower().endswith(".stl")]
    else:
        parts = [[name, data]]
    return {"name": name, "data": data, "parts": parts}
