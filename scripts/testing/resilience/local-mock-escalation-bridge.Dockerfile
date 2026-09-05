FROM scratch
COPY local-mock-escalation-bridge /local-mock-escalation-bridge
USER 65532:65532
ENTRYPOINT ["/local-mock-escalation-bridge"]
