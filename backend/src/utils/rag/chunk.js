// Split document text into small overlapping chunks for RAG.
export const chunkText = (text, chunkSize, overlap) => {
    if (!Number.isInteger(chunkSize) || chunkSize <= 0 || !Number.isInteger(overlap) || overlap < 0 || overlap >= chunkSize) {
        throw new Error('Invalid chunk settings: overlap must be smaller than the chunk size.');
    }
    const chunks = [];
    let start = 0;

    while (start < text.length) {
        const end = start + chunkSize;
        const chunk = text.slice(start, end);

        chunks.push(chunk);
        start = end - overlap;
    }

    return chunks;
};
