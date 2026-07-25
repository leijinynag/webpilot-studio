# Infrastructure

Provider adapters and deployment-specific integrations live here. Domain code
must depend on internal contracts rather than importing database, blob, queue,
LLM, or rate-limit vendors directly.
