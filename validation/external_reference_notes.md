# External Reference Notes for SwitchOS Audit

## OWASP ASVS

Source: https://owasp.org/www-project-application-security-verification-standard/

Key confirmed statement:

> The OWASP Application Security Verification Standard (ASVS) Project provides a basis for testing web application technical security controls and also provides developers with a list of requirements for secure development.

This supports using ASVS as a benchmark for production-readiness and control-coverage discussion in the audit report.

## FastAPI CORS Guidance

Source: https://fastapi.tiangolo.com/tutorial/cors/

Key confirmed statement:

> It's also possible to declare the list as "*" (a "wildcard") to say that all are allowed. But that will only allow certain types of communication, excluding everything that involves credentials: Cookies, Authorization headers like those used with Bearer Tokens, etc. So, for everything to work correctly, it's better to specify explicitly the allowed origins.

This supports the audit conclusion that the current lakehouse CORS settings are not production-safe or production-clear, especially when combined with permissive methods and headers.
