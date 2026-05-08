FROM denoland/deno:alpine-2.5.6
WORKDIR /app
COPY mod.ts .
# Variables to pass at runtime
EXPOSE 8000
CMD ["run","-A","mod.ts"]
