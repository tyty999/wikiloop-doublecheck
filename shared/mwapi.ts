// Copyright 2020 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// This folder includes api convenience  that we use for accessing
// MediaWiki Action API and REST API

import {wikiToDomain} from "@/shared/utility-shared";
import {logger} from "@/server/common";
import * as _ from 'underscore';
const axios = require('axios');
import update from 'immutability-helper';
const MAX_MWAPI_LIMIT:number = 50;
const userAgent = process.env.USER_AGENT || 'WikiLoop DoubleCheck Dev';
const Bottleneck = require("bottleneck");

/**
  "pageid": 48410011,
  "ns": 0,
  "title": "2020 United States presidential election",
  "type": "page",
  "timestamp": "2020-03-28T19:51:23Z"
 */
export interface MwPageInfo {
  pageid?:string,
  ns?:string,
  title?:string,
  timestamp?:string,
}

/**
 * MediaWiki Action API Client Utility
 *
 * @doc https://www.mediawiki.org/wiki/API:Main_page
 */
export class MwActionApiClient {
  private static bottleneck = new Bottleneck({
    minTime: 500
  });
  public static async getMwPageInfosByTitles(wiki:string, titles:string[]):Promise<MwPageInfo[]> {
    console.assert(titles && titles.length > 0 && titles.length <= MAX_MWAPI_LIMIT, `Parameter titles needs to has a length between 1 to ${MAX_MWAPI_LIMIT}}, but was ${titles.length}.`);

    let params = {
    "action": "query",
    "format": "json",
    "prop": "pageprops",
    "titles": titles.join('|')
    };
    let endpoint =`http://${wikiToDomain[wiki]}/w/api.php`;

    let result = await MwActionApiClient.bottleneck.schedule(
      async ()=> await axios.get(endpoint, {params:params, headers: { 'User-Agent': userAgent }}));
    if (Object.keys(result.data.query?.pages).length) {
      return Object.keys(result.data.query.pages).map(pageId=> {
        return result.data.query.pages[pageId]
      });
    }
    return [];
  }

  public static async getRevisionIdsByTitle(
    wiki:string, pageTitle: string,
    startRevId: number = null, limit:number = MAX_MWAPI_LIMIT):Promise<object> {
    // TODO(xinbenlv) validate

    // https://www.mediawiki.org/wiki/Special:ApiSandbox#action=query&format=json&prop=revisions&titles=API%3AGeosearch&rvprop=timestamp%7Cuser%7Ccomment%7Cids&rvslots=main&rvlimit=500&rvdir=older
    let query: any = {
      "action": "query",
      "format": "json",
      "prop": "revisions",
      "titles": pageTitle,
      "rvprop": "ids",
      "rvslots": "main",
      "rvlimit": limit,
      "rvdir": "older",
    };

    if (startRevId) query.rvstart = startRevId;
    let searchParams = new URLSearchParams(query);
    let url = new URL(`http://${wikiToDomain[wiki]}/w/api.php?${searchParams.toString()}`);
    console.log(`Url = `, url);
    try {
      let revisionsJson = (await MwActionApiClient.bottleneck.schedule(async()=> await axios.get(url.toString(), {
        headers: { 'User-Agent': userAgent }
      }))).data;
      let pageId = Object.keys(revisionsJson.query.pages)[0];
      if (revisionsJson.query.pages[pageId].revisions)
        return revisionsJson.query.pages[pageId].revisions.map(item => item.revid);
      else return [];
    } catch (e) {
      logger.warn(e);
      return [];
    }
  }

  /**
   * Get the last-est revisions. This is the only endpoint where MediaWiki
   * allows querying querying various pages.
   *
   * @params ctx see {@link getRawRecentChanges}
   * @returns raw object of recentChanges.
   */
  public static getLatestRevisionIds = async function (ctx) {
    let ctx2 = update(ctx, {
      limit: {$set: MAX_MWAPI_LIMIT}
    });
    let raw = await MwActionApiClient.getRawRecentChanges(ctx2);
    let revIds = raw.query.recentchanges.map(rc => rc.revid);
    return _.sample(revIds, ctx.limit);
  };

  /**
   * Get the last-est revisions. This is the only endpoint where MediaWiki
   * allows querying querying various pages.
   *
   * @params ctx see {@link getRawRecentChanges}
   * @returns raw object of recentChanges.
   */
  public static getLatestOresRevisionIds = async function (ctx) {
    let cloneCtx = { ...ctx };
    cloneCtx.limit = MAX_MWAPI_LIMIT;
    let raw = await MwActionApiClient.getRawRecentChanges(cloneCtx);
    let result = raw.query.recentchanges
      .filter(rc =>
        rc.oresscores.damaging && rc.oresscores.goodfaith &&
        rc.oresscores.damaging.true >= 0.5 && rc.oresscores.goodfaith.false >= 0.5)
      .map(rc => rc.revid);
    // TODO(xinbenlv): when we add test, allow deterministic behavior with seed.
    return _.sample(result, ctx.limit);
  };

  /**
   * Get the last-est revisions. This is the only endpoint where MediaWiki
   * allows querying querying various pages.
   * @param
   * @returns raw object of recentChanges.
   */
  public static getRawRecentChanges = async function ({wiki = 'enwiki', direction, timestamp, limit = 500, bad=false, isLast=false}) {
    let searchParams = new URLSearchParams(
      {
        "action": "query",
        "format": "json",
        "list": "recentchanges",
        "formatversion": "2",
        "rcnamespace": "0",
        "rcprop": "title|timestamp|ids|oresscores|flags|tags|sizes|comment|user",
        "rcshow": "!bot",
        "rclimit": "1",
        "rctype": "edit",
        "rctoponly": "1",
      });
    if (bad) searchParams.set('rcshow', '!bot|oresreview');
    if (isLast) searchParams.set('rctoponly', '1');
    if (direction) searchParams.set(`rcdir`, direction || `older`);
    if (timestamp) searchParams.set(`rcstart`, timestamp || (new Date().getTime()/1000));
    searchParams.set(`rclimit`, limit.toString());

    let url = new URL(`http://${wikiToDomain[wiki]}/w/api.php?${searchParams.toString()}`);
    logger.info(`Requesting for Media Action API: ${url.toString()}`);
    logger.info(`Try sandbox request here: ${new URL(`http://${wikiToDomain[wiki]}/wiki/Special:ApiSandbox#${searchParams.toString()}`)}`);

    let response = await MwActionApiClient.bottleneck.schedule(async () => await axios.get(url.toString(), {
      headers: { 'User-Agent': userAgent }
    }));
    let recentChangesJson = response.data;
    /** Sample response
     {
     "batchcomplete":"",
     "continue":{
        "rccontinue":"20190701214931|1167038199",
        "continue":"-||info"
     },
     "query":{
        "recentchanges":[
           {
              "type":"edit",
              "ns":0,
              "title":"Multiprocessor system architecture",
              "pageid":58955273,
              "revid":904396518,
              "old_revid":904395753,
              "rcid":1167038198,
              "user":"Dhtwiki",
              "userid":9475572,
              "timestamp":"2019-07-01T21:49:32Z",
              "comment":"Putting images at bottom, side by side, to prevent impinging on References section"
           }
           // ...
        ]
     }
    }*/
    return recentChangesJson;
  }

  public static getLastRevisionsByTitles = async function (titles:string[], wiki = 'enwiki', rvcontinue = null) {
    let query: any = {
      "action": "query",
      "format": "json",
      "prop": "revisions",
      "titles": titles.join('|'),
      "rvprop": "ids|timestamp|flags|comment|user|oresscores|tags|userid|roles|flagged"
    };
    if (rvcontinue) {
      query.rvcontinue = rvcontinue;
    }
    let searchParams = new URLSearchParams(query);
    let url = new URL(`http://${wikiToDomain[wiki]}/w/api.php?${searchParams.toString()}`);
    return (await MwActionApiClient.bottleneck.schedule(async () => await axios.get(url.toString(), {
      headers: { 'User-Agent': userAgent }
    }))).data;
  }

  public static getDiffByWikiRevId = async function (wiki:string, revId:number) {
    let query: any = {
      "action": "compare",
      "format": "json",
      "fromrev": `${revId}`,
      "torelative": `prev`,
    };
    let searchParams = new URLSearchParams(query);
    let url = new URL(`http://${wikiToDomain[wiki]}/w/api.php?${searchParams.toString()}`);
    let result = (await MwActionApiClient.bottleneck.schedule(async () =>await axios.get(url.toString(), {
      headers: { 'User-Agent': userAgent }
    }))).data;
    return result;
  }

  /**
   * Given a feed, and wiki, using a title to get all it's category children
   * please note this function handles the "continue" call to MediaWiki Action API
   * it is in charge of making all follow up queries.
   *
   * @param feed
   * @param wiki
   * @param entryArticle
   */
  public static getCategoryChildren = async function (wiki, entryArticle):Promise<MwPageInfo[]> {
    let endpoint =`http://${wikiToDomain[wiki]}/w/api.php`;
    let result = [];
    let params = {
      "action": "query",
      "format": "json",
      "list": "categorymembers",
      "formatversion": "2",
      "cmtitle": entryArticle,
      "cmprop": "ids|timestamp|title",
      "cmlimit": "500",
    };
    let ret = null;

    do {
      ret = await axios.get(endpoint, {params: params, headers: { 'User-Agent': userAgent }});

        /**json
        {
          "batchcomplete": true,
          "continue": {
          "cmcontinue": "page|0f53aa04354b3131430443294f394543293f042d45435331434f394543011f01c4dcc1dcbedc0d|61561742",
          "continue": "-||"
          },
          "query": {
            "categorymembers": [
              {
                "pageid": 48410011,
                "ns": 0,
                "title": "2020 United States presidential election",
                "timestamp": "2020-03-28T19:51:23Z"
              }
            ],
          }
        }
        */
      if (ret.data?.query?.categorymembers?.length > 0) {
        ret.data.query.categorymembers.forEach(item => console.log(`${JSON.stringify(item.title, null, 2)}`));
        result.push(...ret.data.query.categorymembers);
        if (ret.data?.continue?.cmcontinue) params['cmcontinue'] = ret.data.continue.cmcontinue;
      } else {
        return result;
      }
     } while (ret.data?.continue?.cmcontinue);
    return result;
  }
}
