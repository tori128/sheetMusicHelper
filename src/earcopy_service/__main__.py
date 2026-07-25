from __future__ import annotations

import argparse

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(description="EarCopy Assist local service")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if args.host not in {"127.0.0.1", "localhost"}:
        parser.error("ローカルサービスはloopbackアドレスでのみ起動できます")
    uvicorn.run("earcopy_service.api:app", host=args.host, port=args.port)


if __name__ == "__main__":
    main()

