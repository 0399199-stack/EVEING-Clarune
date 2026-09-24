"""Clarune-owned, local-only Real-HAT ordinary x4 inference worker."""
import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

WEIGHT_SHA256 = "f5b1e3bbbb05147ca2beefcc715279cb647d7976cbda67d62ea7e6e20d5ffcc7"


def emit(kind, **values):
    print("CLARUNE_REALHAT " + json.dumps({"type": kind, **values}), flush=True)


class WorkerError(Exception):
    pass


def dependencies():
    try:
        import numpy as np
        from PIL import Image
        import torch
        import torch.nn.functional as functional
        from spandrel import ImageModelDescriptor, ModelLoader
        from spandrel.architectures.HAT import HATArch
        # Importing the architecture as well as the loader detects incomplete installs.
        assert HATArch().id == "HAT"
    except Exception as error:
        raise WorkerError("REALHAT_DEPENDENCIES_MISSING") from error
    try:
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA unavailable")
        probe = torch.ones(1, device="cuda") * 2
        torch.cuda.synchronize()
        if probe.item() != 2:
            raise RuntimeError("CUDA execution unavailable")
        del probe
    except Exception as error:
        raise WorkerError("REALHAT_CUDA_UNAVAILABLE") from error
    return np, Image, torch, functional, ImageModelDescriptor, ModelLoader


def pad_to_window(image, functional):
    # PyTorch reflect requires each pad to be smaller than that dimension.
    # Grow very small images in steps, with replication only for a one-pixel axis.
    remaining_x = (-image.shape[3]) % 16
    remaining_y = (-image.shape[2]) % 16
    while remaining_x:
        amount = min(remaining_x, max(1, image.shape[3] - 1))
        mode = "reflect" if image.shape[3] > 1 else "replicate"
        image = functional.pad(image, (0, amount, 0, 0), mode=mode)
        remaining_x -= amount
    while remaining_y:
        amount = min(remaining_y, max(1, image.shape[2] - 1))
        mode = "reflect" if image.shape[2] > 1 else "replicate"
        image = functional.pad(image, (0, 0, 0, amount), mode=mode)
        remaining_y -= amount
    return image


def infer(args, modules):
    np, Image, torch, functional, ImageModelDescriptor, ModelLoader = modules
    weight = Path(args.model)
    if weight.stat().st_size != 170277017 or hashlib.sha256(weight.read_bytes()).hexdigest() != WEIGHT_SHA256:
        raise WorkerError("REALHAT_RUNTIME_UNVERIFIED")
    torch.set_num_threads(8)
    torch.manual_seed(0)
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    checkpoint = torch.load(weight, map_location="cpu", weights_only=True)
    if not isinstance(checkpoint, dict) or "params_ema" not in checkpoint:
        raise WorkerError("REALHAT_RUNTIME_UNVERIFIED")
    model = ModelLoader().load_from_state_dict(checkpoint["params_ema"])
    if not isinstance(model, ImageModelDescriptor) or model.architecture.id != "HAT" or model.scale != 4:
        raise WorkerError("REALHAT_RUNTIME_UNVERIFIED")
    model.model.load_state_dict(checkpoint["params_ema"], strict=True)
    model.cuda().float().eval()
    del checkpoint
    with Image.open(args.input) as original:
        width, height = original.size
        if width < 1 or height < 1 or width * height * 16 > 40000000 or max(width, height) > 4096:
            raise WorkerError("REALHAT_ENGINE_FAILED")
        original.load()
        alpha = original.convert("RGBA").getchannel("A") if "A" in original.getbands() or "transparency" in original.info else None
        source = np.asarray(original.convert("RGB")).copy()
    grayscale = np.array_equal(source[:, :, 0], source[:, :, 1]) and np.array_equal(source[:, :, 1], source[:, :, 2])
    image = torch.from_numpy(source).permute(2, 0, 1).unsqueeze(0).float() / 255
    image = pad_to_window(image, functional)
    padded_h, padded_w = image.shape[2:]
    tile, pad, scale = args.tile, 32, 4
    result = torch.empty((1, 3, padded_h * scale, padded_w * scale), dtype=torch.float32)
    total = math.ceil(padded_h / tile) * math.ceil(padded_w / tile)
    emit("progress", percent=0)
    with torch.inference_mode():
        count = 0
        for y in range(0, padded_h, tile):
            for x in range(0, padded_w, tile):
                right, bottom = min(x + tile, padded_w), min(y + tile, padded_h)
                x0, y0 = max(x - pad, 0), max(y - pad, 0)
                x1, y1 = min(right + pad, padded_w), min(bottom + pad, padded_h)
                patch = image[:, :, y0:y1, x0:x1].cuda()
                prediction = model(patch)
                if not torch.isfinite(prediction).all():
                    raise WorkerError("REALHAT_ENGINE_FAILED")
                result[:, :, y*scale:bottom*scale, x*scale:right*scale] = prediction[:, :, (y-y0)*scale:(bottom-y0)*scale, (x-x0)*scale:(right-x0)*scale].cpu()
                del patch, prediction
                count += 1
                emit("progress", percent=round(100 * count / total, 2))
    pixels = result[0, :, :height*scale, :width*scale].clamp(0, 1).mul(255).round().byte().permute(1, 2, 0).numpy()
    output = Image.fromarray(pixels)
    if grayscale:
        output = output.convert("L")
    if alpha is not None:
        # The network predicts RGB only. Preserve original coverage, not generated alpha.
        output.putalpha(alpha.resize((width * scale, height * scale), Image.Resampling.LANCZOS))
    output.save(args.output, format="PNG")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--model")
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--tile", type=int, choices=[128, 256, 512], default=256)
    args = parser.parse_args()
    modules = None
    try:
        modules = dependencies()
        if args.probe:
            emit("ready", architecture="HAT", scale=4, cuda=True)
        else:
            if not args.model or not args.input or not args.output:
                raise WorkerError("REALHAT_ENGINE_FAILED")
            infer(args, modules)
        return 0
    except WorkerError as error:
        emit("error", code=str(error))
    except Exception as error:
        torch = modules[2] if modules is not None else None
        out_of_memory = torch is not None and isinstance(error, torch.cuda.OutOfMemoryError)
        emit("error", code="REALHAT_OUT_OF_MEMORY" if out_of_memory else "REALHAT_ENGINE_FAILED")
    return 1


if __name__ == "__main__":
    sys.exit(main())
