# Document-Intelligence Source Notes

**Date:** 2026-09-07

## PaddleOCR

The official PaddleOCR documentation describes PP-OCRv6 as a universal multilingual OCR system and PaddleOCR-VL as a document-parsing VLM. It also states that PaddleOCR 3.x has interface changes relative to 2.x and production integration must use version-matched documentation. The verification design should therefore treat OCR output as bounded extraction evidence, preserve the model/version used, and never elevate OCR confidence to a final eligibility decision without provider or human review.

Source: [PaddleOCR official documentation](https://www.paddleocr.ai/main/en/index.html)

## Docling

The official Docling documentation describes support for multiple document formats, structured document representation, local execution, OCR engines, VLM options, and service deployment. The verification design can use Docling as an optional local structured-document extractor for PDF/image/office evidence, recording its parser/version/output digest. It must not assume Docling verifies issuer authenticity or performs a regulated screening decision.

Source: [Docling official documentation](https://docling-project.github.io/docling/)
