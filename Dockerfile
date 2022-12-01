FROM denoland/deno:1.28.3

EXPOSE 8000
WORKDIR /app
USER deno

COPY deps.ts .
RUN deno cache deps.ts

ADD . .
RUN deno cache main.ts

CMD ["run", "--allow-net", "--allow-read", "--allow-env", "main.ts", "--auction=ws://localhost:11011", "--address=0x03bB3cE1B3020Cac191c9dA927Fc5C228bf5a0af", "--publisher=http://localhost:11012"]
# TODO replace with environment variables
