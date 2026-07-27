import { configure, getConsoleSink } from "@logtape/logtape";
import { createFederation, MemoryKvStore, 
         exportJwk, generateCryptoKeyPair, importJwk } from "@fedify/fedify";
import { Person, Follow, Accept, Undo } from "@fedify/vocab"
import { serve } from "@hono/node-server";
//import { behindProxy } from "x-forwarded-fetch";
import { openKv } from "@deno/kv";

// 로거
await configure({
    sinks: { console: getConsoleSink() },
    filters: {},
    loggers: [
        { category: "fedify", sinks: ["console"], lowestLevel: "info" },
    ],
});

const kv = await openKv("kv.db"); // 키 - 값 저장소

const federation = createFederation<void>({
    kv: new MemoryKvStore(),
});

federation
    // 액터 디스패처
    .setActorDispatcher("/users/{identifier}", async(ctx, identifier) => {
        if(identifier !== "me") return null;    // 해당 서버에 me 외의 actor는 존재하지 않음
        return new Person({
            id: ctx.getActorUri(identifier),
            name: "Me", // Display name
            summary: "This is me", // Bio
            preferredUsername: identifier, //Bare handle
            url: new URL("/", ctx.url),
            inbox: ctx.getInboxUri(identifier), //인박스 URI
            publicKeys: (await ctx.getActorKeyPairs(identifier))  // 액터의 공용 키
                .map(keyPair => keyPair.cryptographicKey),
        });
    })
    // 키페어 디스패처
    .setKeyPairsDispatcher(async (ctx, identifier) => {
        if (identifier !== "me") return [];    // 해당 서버에 me 외의 actor는 존재하지 않음
        const entry = await kv.get<{
            privateKey: JsonWebKey;
            publicKey: JsonWebKey;
        }>(["key"]);
        
        if (entry == null || entry.value == null) {
            // 키페어가 없으면 새로 생성
            const { privateKey, publicKey } = await generateCryptoKeyPair("RSASSA-PKCS1-v1_5");
            // 생성된 키 페어를 JWK로 변환하여 Deno KV 데이터베이스에 저장
            await kv.set(["key"], {
                privateKey: await exportJwk(privateKey),
                publicKey: await exportJwk(publicKey),
            });
            return [{ privateKey, publicKey }];
        }
        // Deno KV 데이터베이스에서 키 페어 로드
        const privateKey = await importJwk(entry.value.privateKey, "private");
        const publicKey = await importJwk(entry.value.publicKey, "public");
        return [{ privateKey, publicKey }];
    });


// 인박스 리스너
federation
    .setInboxListeners("/users/{identifier}/inbox", "/inbox")
    // 팔로우 요청 처리
    .on(Follow, async(ctx, follow) => {
        if(follow.id == null || follow.actorId == null || follow.objectId == null) {
            return;
        }
        const parsed = ctx.parseUri(follow.objectId);
        if (parsed?.type !== "actor" || parsed.identifier !== "me") return;
        const follower = await follow.getActor(ctx);
        if (follower == null) return;
        // 서버가 `Follow` 활동을 받으면, `Accept` 또는 `Reject` 활동으로 응답해야 합니다. 이 경우, 서버는 팔로우 요청을 자동으로 수락
        await ctx.sendActivity(
            { identifier: parsed.identifier },
            follower,
            new Accept({ actor: follow.objectId, object: follow }),
        );
        // 팔로워를 키-값 저장소에 저장
        if (follower.id == null) return;
        await kv.set(["followers", follower.id.href], follow.actorId.href);
    })
    // 언팔로우 요청 처리
    .on(Undo, async(ctx, undo) => {
        if (undo.id == null || undo.actorId == null || undo.objectId == null) return;
        const parsed = ctx.parseUri(undo.objectId);
        if (parsed?.type !== "actor" || parsed.identifier !== "me") return;
        const unfollower = await undo.getActor(ctx);
        if (unfollower == null) return;
        // 서버가 `Undo` 활동을 받으면, `Accept` 또는 `Reject` 활동으로 응답해야 합니다. 이 경우, 서버는 언팔로우 요청을 자동으로 수락
        await ctx.sendActivity(
            { identifier: parsed.identifier },
            unfollower,
            new Accept({ actor: undo.objectId, object: undo}),
        );
        if (unfollower.id == null) return;
        // 팔로워를 키-값 저장소에서 제거
        await kv.delete(["followers", unfollower.id.href]);
    })

serve({
    port: 8000,
    async fetch(request) {
        const url = new URL(request.url);
        // 홈페이지
        if (url.pathname === "/") {
            const followers: string[] = [];
            for await (const entry of kv.list({ prefix: ["followers"] })) {
                if (followers.includes(entry.value as string)) continue;
                followers.push(entry.value as string);
            }
            return new Response(
                `<ul>${followers.map((f) => `<li>${f}</li>`)}</ul>`,
                {
                    headers: { "Content-Type": "text/html; charset=utf-8" },
                },
            );
        }
        // 연합 관련 요청은 Federation 객체에 의해 처리됨
        return await federation.fetch(request, { contextData: undefined });
    }
});