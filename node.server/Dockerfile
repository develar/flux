# official node images are bloated, but we cannot use slim version - Python is required for gyp
FROM node:wheezy

COPY package.json README.md /app/
WORKDIR /app
RUN npm install
COPY . /app

EXPOSE 3000
ENTRYPOINT ["npm", "start"]