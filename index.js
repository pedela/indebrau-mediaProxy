require('dotenv').config();
const request = require('request');
const fs = require('fs');
const { GraphQLClient } = require('graphql-request');

const userMail = process.env.USERMAIL;
const userName = process.env.USERNAME;
const userPw = process.env.USERPW;
const backendLocation = process.env.BACKENDLOCATION;
const cacheUpdateInterval = process.env.CACHEUPDATEINTERVAL; // in seconds
const camRequestInterval = process.env.CAMREQUESTINTERVAL; // in seconds
const backOffInterval = process.env.BACKOFFINTERVAL;

var graphQLClient = new GraphQLClient(backendLocation);
var authToken = ''; // needed for the image upload, since it uses a different uploader client
var activeMediaStreamsCache = {}; // holds a list of active media streams
var lastCacheUpdateTimeStamp = null; // last update of cache

var lastTimeStampMainView = new Date();
var lastErrorMainView = new Date(); // to back off a little after an error

async function main() {
  // startup process
  console.log('Startup...');
  // login or register input user
  await loginOrRegister();
  // populate the initial active media streams cache
  await updateMediaStreamsCache();
  console.log('Started!');
  // finished startup, now start image retrieval process
  setInterval(uploadImage, camRequestInterval * 1000);
}

main();

async function uploadImage() {
  if (new Date() - lastCacheUpdateTimeStamp > cacheUpdateInterval * 1000) {
    // don't wait for this, might result in 1-2 seconds delayed update (and multiple updates),
    // which is ok (in comparison to pausing the media processing)
    updateMediaStreamsCache();
  }

  // check if media stream exists
  let mainViewMediaStream = null;
  for (let i = 0; i < activeMediaStreamsCache.length; i++) {
    if (activeMediaStreamsCache[i].mediaFilesName === 'mainView') {
      // found it
      mainViewMediaStream = activeMediaStreamsCache[i];
      break;
    }
  }
  if (!mainViewMediaStream) return; // no active stream exists for this view

  // check if update is too recent or error
  if (new Date() - lastTimeStampMainView <
    mainViewMediaStream.updateFrequency * 1000
    ||
    new Date() - lastErrorMainView <
    backOffInterval * 1000
  ) {
    return;
  }
  console.log("requesting image");

  // temporary cache the "old" last time stamp in case of failure with upload
  let oldLastTimeStampMainView = lastTimeStampMainView;
  lastTimeStampMainView = new Date();

  request.head('http://192.168.50.160', {timeout: mainViewMediaStream.updateFrequency * 1000}, function(err){
    if (err){
      console.log('error querying camera: ' + err);
      lastTimeStampMainView = oldLastTimeStampMainView;
      lastErrorMainView = new Date();
      return;
    }
    let stream = request('http://192.168.50.160');
    stream.on('error', function(err) {
      console.log('stream request error: ' + err );
      lastTimeStampMainView = oldLastTimeStampMainView;
      lastErrorMainView = new Date();
      return;
    }).pipe(
      fs.createWriteStream('tempImage.jpg')
        .on('error', function(err){
          console.log('Stream write error: ' + err);
          lastTimeStampMainView = oldLastTimeStampMainView;
          lastErrorMainView = new Date();
          return;
        })
    ).on('close', function() {
      let formData = {
        mediaStreamName: 'mainView',
        mediaMimeType: 'IMAGE_JPG',
        mediaTimestamp: lastTimeStampMainView.toJSON(),
        mediaData: fs.createReadStream('tempImage.jpg'),
      };
      request.post({
        url: `${backendLocation}/uploadMedia`,
        headers: {
          'Authorization': 'Bearer ' + authToken
        },
        formData: formData
      }, function cb(err, httpResponse, identifier) {
        if (err) {
          lastTimeStampMainView = oldLastTimeStampMainView;
          lastErrorMainView = new Date();
          console.error('Failed upload:', err);
        } else{
          // TODO: check, if data was acutally stored on server side
          // since currently, only correct upload is checked for here
          console.log('Request send, server returned:', identifier);
        }
      });
    });
  });
}

async function loginOrRegister() {
  console.log('Login user...');
  let mutation = /* GraphQL */ `
    mutation signin($email: String!, $password: String!) {
      signin(email: $email, password: $password) {
        token
      }
    }
  `;
  let variables = {
    email: userMail,
    password: userPw
  };
  try {
    let data = await graphQLClient.request(mutation, variables);
    authToken = data.signin.token;
    graphQLClient = new GraphQLClient(backendLocation, {
      headers: {
        Authorization: 'Bearer ' + authToken
      }
    });
    console.log('Logged in!');
  } catch (e) {
    console.log('Login not possible, trying to register new user...');

    mutation = /* GraphQL */ `
      mutation signup($name: String!, $password: String!, $email: String!) {
        signup(name: $name, password: $password, email: $email) {
          token
        }
      }
    `;
    variables = {
      name: userName,
      password: userPw,
      email: userMail
    };
    try {
      let data = await graphQLClient.request(mutation, variables);
      authToken = data.signin.token;
      graphQLClient = new GraphQLClient(backendLocation, {
        headers: {
          Authorization: 'Bearer ' + authToken
        }
      });
      console.log('Registered new user!');
    } catch (e) {
      // No login and signup possible...
      console.log(e);
      process.exit(1);
    }
  }
}

async function updateMediaStreamsCache() {
  // temporary cache the "old" last time stamp in case of failure with updating
  let oldLastCacheUpdateTimeStamp = lastCacheUpdateTimeStamp;
  lastCacheUpdateTimeStamp = new Date();
  let query = /* GraphQL */ `
    {
      mediaStreams(active: true) {
        id
        mediaFilesName
        updateFrequency
        brewingProcess {
          id
        }
      }
    }
  `;
  try {
    let data = await graphQLClient.request(query);
    // a bit of data flattening
    for (let i = 0; i < data.mediaStreams.length; i++) {
      data.mediaStreams[i].brewingProcess =
        data.mediaStreams[i].brewingProcess.id;
    }
    activeMediaStreamsCache = data.mediaStreams;
    console.log('Updated cache at: ' + lastCacheUpdateTimeStamp);
  } catch (e) {
    // "reset" timestamp
    lastCacheUpdateTimeStamp = oldLastCacheUpdateTimeStamp;
    console.log('Error, cache not updated: ' + e);
  }
}
