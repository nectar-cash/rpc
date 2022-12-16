FROM denoland/deno:1.29.1

EXPOSE 8000
WORKDIR /app
USER deno

COPY deps.ts .
RUN deno cache deps.ts

ADD . .
RUN deno cache main.ts

CMD ["run", "--allow-net", "--allow-read", "--allow-env", "main.ts"]
