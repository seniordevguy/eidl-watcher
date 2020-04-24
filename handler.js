'use strict';

const AWS = require('aws-sdk');
const axios = require('axios').default;

// twilio client
const twilioClient = require('twilio')(
  process.env.TWILIO_ACCOUNT_SID, 
  process.env.TWILIO_AUTH_TOKEN
);

// lambda client
const lambda = new AWS.Lambda({
  region: 'us-east-1'
});

// dynamodb client
const dynamoDb = new AWS.DynamoDB.DocumentClient();

module.exports.check_site = async _ => {
  const params = {
    TableName: process.env.STATE_TABLE,
    ProjectionExpression: 'id,app_state'
  };

  try {
    // get app state from db, if its true that means the cron shouldnt run anymore
    const data = await dynamoDb.scan(params).promise();
    if (data.Items[0].app_state) {
      const message = 'Site is live. dont run cron job anymore';
      console.log(message);
      return { message };
    }

    // call eidl site to see if redirect response url changed yet
    const response = await axios.get('https://covid19relief.sba.gov');
    if (response.request.res.responseUrl == "https://www.sba.gov/disaster-assistance/coronavirus-covid-19") {
      return { message: "Application site is not live yet." };
    }

    // if it has, launch lambda to process sms
    const lambData = await lambda.invoke({ 
      FunctionName: `${process.env.APP_NAME}-${process.env.APP_ENV}-process_sms`
    }).promise();

    // update app state
    const updateParams = {
      TableName: process.env.STATE_TABLE,
      Key: {
        id: 'eidl'
      },
      UpdateExpression: 'set app_state = :app_state',
      ExpressionAttributeValues: {
          ':app_state': true
      },
      ReturnValues: 'UPDATED_NEW'
    };

    await dynamoDb.update(updateParams).promise();

    const message = 'Fired off SMS process lambda successfully!';
    console.log(message, lambData);
    return { message, lambData };
  } catch (err) {
    console.log(err)
    return { error: JSON.stringify(err) };
  }
};

module.exports.process_sms = async _ => {
  const params = {
    TableName: process.env.USER_TABLE,
    FilterExpression: 'sent = :sent',
    ExpressionAttributeValues : {
        ':sent': false
    }   
  };

  try {
    // get all phone numbers in the db that arent marked as sent
    const data = await dynamoDb.scan(params).promise();
    const chunk = 50;
    let count = 0;
    const lambResps = [];
    const phoneNumbers = data.Items;

    // chunk phone numbers into chunks of 50 and launch lambdas
    while (phoneNumbers.length) {
        const chunkedNumbers = phoneNumbers.splice(0, chunk);
        console.log(chunkedNumbers)
        
        // launch lambda for each chunk of phone numbers
        const lambData = await lambda.invoke({ 
          FunctionName: `${process.env.APP_NAME}-${process.env.APP_ENV}-send_sms`,
          Payload: JSON.stringify(chunkedNumbers)
        }).promise();

        // push resp to array
        lambResps.push(lambData);
        count++;
    }

    // send response back
    const message = `Launched ${count} SMS Lambdas!`;
    console.log(message, lambResps);
    return { message, lambResps };
  } catch (err) {
    console.log(err);
    return { error: JSON.stringify(err) };
  }
};

module.exports.send_sms = async event => {
  try {
    // parse phone number array from event payload
    console.log(event);
    const phoneNumbers = event;
    const entryResps = [];

    // loop through each phone number and send sms from twilio
    for (let i = 0; i < phoneNumbers.length; i++) {
      const resp = await twilioClient.messages.create({
        body: 'COVID SITE IS ONLINE! - https://covid19relief.sba.gov',
        messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
        to: phoneNumbers[i].phone_number
      });

      // push sid to array
      let entryResp = { sId: resp.sid };

      // mark sent: true, in dynamodb
      const params = {
        TableName: process.env.USER_TABLE,
        Key: {
          phone_number: phoneNumbers[i].phone_number
        },
        UpdateExpression: 'set sent = :sent',
        ExpressionAttributeValues:{
          ':sent': true
        },
        ReturnValues: 'UPDATED_NEW'
      };

      await dynamoDb.update(params).promise();

      // add entry to the array resp
      entryResp.phoneNumber = phoneNumbers[i].phoneNumber
      entryResps.push(entryResp);
    }

    // send response back
    const message = 'Processed all SMS successfully!';
    console.log(message, entryResps);
    return { message, entryResps };
  } catch (err) {
    console.log(err);
    return { error: JSON.stringify(err) };
  }
};
