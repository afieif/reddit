import fetch from "node-fetch";
import fs from "fs";

const URL = 'https://www.reddit.com/r/MenopauseShedforMen/new.json?limit=100';
const MAX_POSTS = 600;
const BATCH_SIZE = 50;
const MIN_SLEEP = 5000;
const MAX_SLEEP = 10000;
const RANDOM_EXTRA_DELAY = 3000;
let lastRequestTime = 0;
let consecutiveErrors = 0;
let uniqueUsers = new Set();

// Ensure output directory exists
const OUTPUT_DIR = './output';
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR);
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getRandomDelay() {
    return Math.floor(Math.random() * RANDOM_EXTRA_DELAY);
}

async function makeRequest(url, retries = 3) {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    const randomDelay = getRandomDelay();
    
    if (timeSinceLastRequest < (MIN_SLEEP + randomDelay)) {
        await sleep(MIN_SLEEP + randomDelay - timeSinceLastRequest);
    }

    try {
        const response = await fetch(url);
        lastRequestTime = Date.now();
        
        if (response.status === 429) {
            consecutiveErrors++;
            const waitTime = Math.min(MAX_SLEEP * Math.pow(2, consecutiveErrors - 1) + getRandomDelay(), 30000);
            console.log(`Rate limited. Waiting ${Math.round(waitTime/1000)} seconds...`);
            await sleep(waitTime);
            if (retries > 0) return makeRequest(url, retries - 1);
            throw new Error('Rate limited');
        }

        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }

        consecutiveErrors = 0;
        return await response.json();
    } catch (error) {
        if (retries > 0) {
            const retryDelay = 2000 + getRandomDelay();
            await sleep(retryDelay);
            return makeRequest(url, retries - 1);
        }
        throw error;
    }
}

async function fetchComments(post) {
    if (!post.data.num_comments) return [];
    
    try {
        await sleep(5000 + getRandomDelay());
        const commentsJson = await makeRequest(`${post.data.url}.json`);
        if (!commentsJson[1]?.data?.children) return [];

        return commentsJson[1].data.children
            .filter(comment => comment.data && comment.data.author && comment.data.body)
            .map(comment => {
                uniqueUsers.add(comment.data.author);
                return comment.data.body;
            });
    } catch (error) {
        console.warn(`Failed to fetch comments for post ${post.data.url}:`, error.message);
        return [];
    }
}

async function writeBatch(batch, filename) {
    const filePath = `${OUTPUT_DIR}/${filename}`;
    let existing = [];
    
    if (fs.existsSync(filePath)) {
        existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    
    fs.writeFileSync(filePath, JSON.stringify([...existing, ...batch], null, 2));
}

async function fetchRedditData() {
    let currentBatch = [];
    let after = null;
    let totalFetched = 0;

    try {
        while (totalFetched < MAX_POSTS) {
            const apiUrl = `${URL}${after ? `&after=${after}` : ''}`;
            const json = await makeRequest(apiUrl);

            if (!json.data?.children?.length) {
                console.warn("No more posts available.");
                break;
            }

            // Process posts in parallel batches
            const postPromises = json.data.children.map(async (child) => {
                if (totalFetched >= MAX_POSTS) return null;

                const texts = [];
                if (child.data.selftext) {
                    texts.push(child.data.selftext);
                    uniqueUsers.add(child.data.author);
                }

                totalFetched++;

                // Fetch comments for this post
                const comments = await fetchComments(child);
                texts.push(...comments);

                return texts;
            });

            const results = await Promise.all(postPromises);
            const flatResults = results.filter(Boolean).flat();
            currentBatch.push(...flatResults);

            // Write batch if it reaches threshold
            if (currentBatch.length >= BATCH_SIZE) {
                await writeBatch(currentBatch, 'Menopause_mens_texts.json');
                currentBatch = [];
            }

            console.log(`Processed ${totalFetched} posts (${uniqueUsers.size} unique users so far)`);
            after = json.data.after;
            if (!after) break;
        }

        // Write any remaining items
        if (currentBatch.length > 0) {
            await writeBatch(currentBatch, 'Menopause_texts.json');
        }

        // Write final stats
        console.log(`\nProcessing complete!`);
        console.log(`Total posts processed: ${totalFetched}`);
        console.log(`Total unique users: ${uniqueUsers.size}`);

    } catch (err) {
        console.error("Error fetching data:", err);
        if (currentBatch.length > 0) {
            await writeBatch(currentBatch, 'Menopause_texts.json');
        }
    }
}

fetchRedditData();
