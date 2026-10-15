/*createDocumentFromUploadService must first save the file information and create the document record with status = 'processing'*/
import {safeExecute} from "../../../../db/config.js";
import fs from 'fs/promises';
import {PDFParse} from 'pdf-parse';
import { generateQuestionEmbedding } from "../../../utils/ai/embedding.js";
import { chunkText } from "../../../utils/rag/chunk.js";
import { normalizeQueryText, getVectorConfig, calculateCosineSimilarity } from "../../../utils/rag/vector.js";
import { answerFromRagChunks } from "../../../utils/rag/answer.js";
import {NotFoundError} from "../../../utils/errors/index.js";
import path from "path";

let chunkSize = Number(process.env.RAG_CHUNK_CHARS || 1000);
let overlap = Number(process.env.RAG_CHUNK_OVERLAP || 150);

// # Task: Upload & Process RAG Document[T-22]
//Endpoint: POST /api/rag/documents
export const createDocumentFromUploadService = async (file, userId) => {
    let documentId;
    try {
        const counts = await safeExecute('SELECT COUNT(*) AS documentCount FROM documents WHERE user_id = ?', [userId]);
        const maxPerUser = Math.min(20, Number(process.env.RAG_MAX_PDFS_PER_USER) || 20);
        if (Number(counts[0].documentCount) >= maxPerUser) {
            throw new Error(`You have reached the maximum of ${maxPerUser} PDFs.`);
        }
        const result = await safeExecute(`INSERT INTO documents
            (user_id, title, mime_type, storage_path, byte_size, status)
            VALUES (?, ?, ?, ?, ?, 'processing')`,
            [userId, file.originalname, file.mimetype, file.path, file.size]);
        documentId = result.insertId;

        const parser = new PDFParse({ data: await fs.readFile(file.path) });
        let text;
        try { text = (await parser.getText()).text; }
        finally { await parser.destroy(); }
        const minimum = Number(process.env.RAG_MIN_TEXT_CHARS || process.env.RAG_TEXT_CHARS || 50);
        if (!text || text.trim().length < minimum) throw new Error('PDF does not contain enough usable text.');
        const chunks = chunkText(text, chunkSize, overlap);
        if (!chunks.length) throw new Error('PDF could not be split into usable text chunks.');
        const maximum = Number(process.env.RAG_MAX_CHUNKS_PER_DOC) || 100;
        if (chunks.length > maximum) throw new Error('Document contains too many chunks.');

        for (let i = 0; i < chunks.length; i++) {
            const chunk = await safeExecute('INSERT INTO document_chunks (document_id, chunk_index, content) VALUES (?, ?, ?)', [documentId, i, chunks[i]]);
            const embedding = await generateQuestionEmbedding(chunks[i], { taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: 768 });
            await safeExecute(`INSERT INTO document_chunk_vectors (chunk_id, source_text, embedding, status)
                VALUES (?, ?, ?, 'ready')`, [chunk.insertId, chunks[i], JSON.stringify(embedding)]);
        }
        await safeExecute("UPDATE documents SET status = 'ready' WHERE document_id = ?", [documentId]);
        return { document_id: documentId, title: file.originalname, mime_type: file.mimetype,
            byte_size: file.size, status: 'ready', storage_path: file.path, user_id: userId };
    } catch (error) {
        // A rejected or unfinished upload should not occupy space or a user's PDF quota.
        if (documentId) {
            try { await safeExecute('DELETE FROM documents WHERE document_id = ? AND user_id = ?', [documentId, userId]); }
            catch (cleanupError) { console.error('Unable to remove unfinished document:', cleanupError.message); }
        }
        try { await fs.unlink(file.path); }
        catch (cleanupError) { if (cleanupError.code !== 'ENOENT') console.error('Unable to remove rejected PDF:', cleanupError.message); }
        throw error;
    }
};

// # Task: Semantic Search in RAG Document[T-23]
//Endpoint: GET /api/rag/documents/:documentId/search
export const searchInDocumentService = async (documentId, searchQuery, k, userId) => {
    //verify the document belongs to user and the doc is ready for searching
    const vectorConfig = getVectorConfig();
    const threshold = vectorConfig.ragThreshold;//from .env
    k = k ? Number(k) : vectorConfig.ragK;//from .env 

    let documentSql = `SELECT document_id
        FROM documents
        WHERE document_id = ?
        AND user_id = ?
        AND status = 'ready'
    `;
    const documentRows = await safeExecute(documentSql, [documentId, userId]);

    //console.log(documentRows);
    if(documentRows.length=== 0){
        throw new NotFoundError('Document not found or not ready for search.');
    }

    // 2. Convert the user's search question into an embedding.
    //    This is a RETRIEVAL_QUERY embedding because this embedding represents the // * user's search query. 
    const sourceQueryText = normalizeQueryText({
            title: searchQuery
    });

    let queryEmbedding; 
    try {
        queryEmbedding = await generateQuestionEmbedding(
        sourceQueryText, {
            taskType: 'RETRIEVAL_QUERY',
            outputDimensionality: 768
        });
        //console.log("queryEmbedding", queryEmbedding);// # gives obj {embedding: []} not the array of numbers so do queryEmbedding.embedding

        if (!queryEmbedding || !queryEmbedding.embedding || queryEmbedding.embedding.length === 0) {
            throw new Error("gemini Api did not return valid embedding for user's search query")
        }
    } catch (error) {
        throw error;
    }
   

    // 3. Get all chunk vectors belonging to this document.

    let vectorSql = `
        SELECT
            dcv.chunk_vector_id,
            dcv.chunk_id,
            dcv.embedding,
            dc.chunk_index
        FROM document_chunk_vectors dcv
        INNER JOIN document_chunks dc
            ON dcv.chunk_id = dc.chunk_id
        WHERE dc.document_id = ?
        AND dcv.status = 'ready'
    `;
    let vectorRows
    try {
        vectorRows = await safeExecute(vectorSql, [
        documentId
    ]);
    } catch (error) {
        console.log("error from mysql when processing vector sql", error);
        throw error;
    }
    //embeddings of chunks of the document
    


    // 4. Calculate similarity between the query embedding(user's search query) and every stored chunk embedding.
    
    const scoredChunks = [];

    

    for (let row of vectorRows) {
        
       let  chunkEmbedding = typeof row.embedding === "string" ? JSON.parse(row.embedding) : row.embedding;
       //console.log("chunkEmbedding", chunkEmbedding);// # gives obj {embedding: []} not the array of numbers
        //it comes from mysql as strimg so parse it

        let score = calculateCosineSimilarity(
            queryEmbedding.embedding,
            chunkEmbedding.embedding
        );
        //console.log("score", score);

         // 5. Apply the threshold from .env.
        //    Only keep chunks with score >= 0.7.

        if (score >= threshold) {
            scoredChunks.push({
                chunkId: row.chunk_id,
                chunkIndex: row.chunk_index,
                score: score
            }); 
        }
    }

    // 6. Sort from highest similarity to lowest similarity.

    scoredChunks.sort((a, b) => { return b.score - a.score;});
    //console.log("scoredChunks", scoredChunks);
    // 7. Keep only the top k results.

    let topChunks = scoredChunks.slice(0, k);
    //console.log("topChunks", topChunks);
   /* // 8. Get the actual text for those chunks.

    let results = [];

    for (let chunk of topChunks) {
        let chunkSql = `
            SELECT content
            FROM document_chunks
            WHERE chunk_id = ?
        `;

        let chunkRows = await safeExecute(chunkSql, [
            chunk.chunkId
        ]);

        if (chunkRows.length > 0) {
            results.push({
                chunkId: chunk.chunkId,
                chunkIndex: chunk.chunkIndex,
                score: chunk.score,
                excerpt: chunkRows[0].content
            });
        }
    }*/
   // ! ========= to remove N+1 problem ===========
    // 8. Get all chunk IDs.
    let chunkIds = topChunks.map(chunk => chunk.chunkId);
    //console.log("chunkids", chunkIds);

    if (chunkIds.length === 0) {
        console.log("chunkids is empty", chunkIds);
        return [];
    }

    // 9. Fetch all chunk contents in ONE query.
    let placeholders = chunkIds.map(() => '?').join(',');

    let chunkSql = `
        SELECT chunk_id, content
        FROM document_chunks
        WHERE chunk_id IN (${placeholders})
    `;

    let chunkRows = await safeExecute(chunkSql, chunkIds);

    // 10. Create a lookup map.
    let contentById = new Map(
        chunkRows.map(row => [row.chunk_id, row.content])
    );//to store chunk_id and content in key-value pair for faster access

    // 11. Build results while preserving similarity order.
    let results = [];

    for (let chunk of topChunks) {
        let content = contentById.get(chunk.chunkId);

        if (content !== undefined) {
            results.push({
                chunkId: chunk.chunkId,
                chunkIndex: chunk.chunkIndex,
                score: chunk.score,
                excerpt: content
            });
        }
    }


    return results; //the contents/actual texts of the top k chunks



    

}

// # Task: AI Query Grounded in RAG Document[T-23]
// Endpoint: POST /api/rag/documents/:documentId/query
export let queryDocumentService = async (
    documentId,
    searchQuery,
    userId
) => {

    // 1. Perform semantic search.
    // * This reuses the same RAG search logic from T-23 /search.

    let chunks = await searchInDocumentService(
        documentId,
        searchQuery,
        5,
        userId
    );


    // 2. If no relevant chunks were found,
    // there is no document context that we can give Gemini.

    if (chunks.length === 0) {
        return {
            answer: 'I could not find relevant information in this document to answer the question.',
            citations: [],
            chunksUsed: []
        };
    }


    // 3. Send the retrieved chunks and the user's question
    // to Gemini.

    let answer = await answerFromRagChunks(
        searchQuery,
        chunks
    );//it Passes the user's query and the extracted chunk text to a Gemini generation prompt which will return the final answer


    // 4. Build the source information.

    let citations = [];

    let chunksUsed = [];

    for (let i = 0; i < chunks.length; i++) {
        citations.push({
            ref: i + 1,
            chunkIndex: chunks[i].chunkIndex
        });

        chunksUsed.push(chunks[i].chunkId);
    }


    // 5. Return the answer and its sources.

    return {
        answer: answer,
        citations: citations,
        chunksUsed: chunksUsed
    };
};


// # Task: Get RAG Document Metadata[T-24]
// Endpoint: GET /api/rag/documents/:documentId
export const getDocumentMetaService = async (documentId, userId) => {
    const sql = `
        SELECT
            document_id,
            title,
            mime_type,
            byte_size,
            status,
            error_message,
            created_at,
            updated_at,
            user_id,
            storage_path
        FROM documents
        WHERE document_id = ?
          AND user_id = ?
    `;

    const rows = await safeExecute(sql, [documentId, userId]);

    if (rows.length === 0) {
        throw new NotFoundError('Document not found.');
    }

    return rows[0];
};

// # Task: Stream RAG Document PDF[T-24]
// Endpoint: GET /api/rag/documents/:documentId/file
export const getAssertOwnedDocumentPathService = async (documentId, userId) => {
    const sql = `
        SELECT storage_path, mime_type
        FROM documents
        WHERE document_id = ?
          AND user_id = ?
    `;

    const rows = await safeExecute(sql, [documentId, userId]);

    if (rows.length === 0) {
        throw new NotFoundError('No document found for this user.');
    }

    const filePath = path.resolve(rows[0].storage_path);

    try {
        await fs.access(filePath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new NotFoundError('File not found.');
        }
        throw error;
    }

    return {
        filePath,
        mimeType: rows[0].mime_type
    };
};

// # Task: List My RAG Documents[T-24]
// Endpoint: GET /api/rag/documents
export const listDocumentsForUserService = async (userId) => {
    const sql = `
        SELECT
            document_id,
            title,
            mime_type,
            byte_size,
            status,
            error_message,
            created_at,
            updated_at
        FROM documents
        WHERE user_id = ?
        ORDER BY created_at DESC
    `;

    return await safeExecute(sql, [userId]);
};

// # Task: Delete RAG Document
// Endpoint: DELETE /api/rag/documents/:documentId
export const deleteDocumentService = async (documentId, userId) => {
    const document = await getAssertOwnedDocumentPathService(documentId, userId);

    try {
        await fs.unlink(document.filePath);
    } catch (error) {
        // A missing file should not prevent deletion of its database record.
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }

    const deleteSql = `
        DELETE FROM documents
        WHERE document_id = ?
          AND user_id = ?
    `;

    await safeExecute(deleteSql, [documentId, userId]);

    return { id: Number(documentId) };
};
